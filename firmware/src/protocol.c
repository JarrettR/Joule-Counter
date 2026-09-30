/*
 * PPK2 host protocol on the USB data port.
 *
 * Commands arrive as an opcode byte followed by a fixed number of argument
 * bytes. Replies are either the metadata text (terminated by "END") or the
 * binary block stream (see ppk2.h), never both at once.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <math.h>
#include <stddef.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/net_buf.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/sys/reboot.h>
#include <zephyr/logging/log.h>

#include "board_io.h"
#include "metadata.h"
#include "power.h"
#include "ppk2.h"
#include "protocol.h"
#include "sampling.h"
#include "usb_ppk.h"

LOG_MODULE_REGISTER(protocol, CONFIG_LOG_DEFAULT_LEVEL);

#define CMD_MAX_ARGS		5
#define CMD_QUEUE_DEPTH		16
#define CMD_INTERNAL_LINK	0xFE	/* data port connected / disconnected */

/*
 * How long the pump waits for a free transfer slot before it looks at the
 * stream state again. Waiting loses nothing by itself: the ring keeps
 * filling, and if the host stays away long enough to overflow it, the loss
 * is accounted exactly.
 */
#define TX_BLOCK_TIMEOUT	K_MSEC(100)
#define TX_TEXT_TIMEOUT		K_MSEC(500)

/* Longest a stop waits for the stream's tail and final block to go out. */
#define FLUSH_TIMEOUT		K_MSEC(500)

#define LINK_TEST_MAX_SECONDS	60U

#define BLOCK_BYTES_MAX		PPK2_BLOCK_BYTES_MAX
#define BLOCK_HEADER_SIZE	sizeof(struct ppk2_block_header)

struct cmd {
	uint8_t op;
	uint8_t len;
	uint8_t arg[CMD_MAX_ARGS];
};

/* Argument byte count per opcode; -1 marks opcodes this firmware does not know. */
static const int8_t cmd_arg_len[0x31] = {
	[0 ... 0x30] = -1,
	[PPK2_CMD_TRIGGER_SET] = 2,
	[PPK2_CMD_AVG_NUM_SET] = 1,
	[PPK2_CMD_TRIGGER_WINDOW_SET] = 2,
	[PPK2_CMD_TRIGGER_INTERVAL_SET] = 1,
	[PPK2_CMD_TRIGGER_SINGLE_SET] = 0,
	[PPK2_CMD_AVERAGE_START] = 0,
	[PPK2_CMD_AVERAGE_STOP] = 0,
	[PPK2_CMD_RANGE_SET] = 1,
	[PPK2_CMD_LCD_SET] = 1,
	[PPK2_CMD_TRIGGER_STOP] = 0,
	[PPK2_CMD_DEVICE_RUNNING_SET] = 1,
	[PPK2_CMD_REGULATOR_SET] = 2,
	[PPK2_CMD_SWITCH_POINT_DOWN] = 1,
	[PPK2_CMD_SWITCH_POINT_UP] = 1,
	[PPK2_CMD_SET_POWER_MODE] = 1,
	[PPK2_CMD_RES_USER_SET] = 3,
	[PPK2_CMD_SPIKE_FILTERING_ON] = 0,
	[PPK2_CMD_SPIKE_FILTERING_OFF] = 0,
	[PPK2_CMD_GET_METADATA] = 0,
	[PPK2_CMD_RESET] = 0,
	[PPK2_CMD_SET_USER_GAINS] = 5,
	[PPK2_CMD_LINK_TEST] = 1,
};

K_MSGQ_DEFINE(cmd_q, sizeof(struct cmd), CMD_QUEUE_DEPTH, 4);

/*
 * Serialises everything that goes out on the data port: a block is
 * allocated, packed and queued under it, so an abort or a text reply never
 * lands between the steps of one.
 */
static K_MUTEX_DEFINE(tx_lock);

static volatile bool streaming;
static uint8_t stream_id;
static struct protocol_stats stats;

/* The pump gives this once a stopped stream has gone out completely. */
static K_SEM_DEFINE(flushed, 0, 1);

/* Link test: the pump sends test blocks until link_test_end (uptime, ms),
 * pseudo-random packed samples when link_test_pack is set.
 */
#define LINK_TEST_PACK		BIT(7)
static volatile bool link_test_active;
static volatile bool link_test_pack;
static volatile bool link_test_busy;
static volatile int64_t link_test_end;

/* Parser state, touched only from the USB receive context. */
static struct cmd partial;
static bool partial_active;

/* ---- block framing ----------------------------------------------------- */

static uint32_t crc_table[256];

static void crc_init(void)
{
	for (uint32_t n = 0; n < ARRAY_SIZE(crc_table); n++) {
		uint32_t c = n;

		for (int k = 0; k < 8; k++) {
			c = (c & 1U) ? 0xEDB88320U ^ (c >> 1) : c >> 1;
		}
		crc_table[n] = c;
	}
}

/* CRC-32 as zlib computes it; block_crc32(block_crc32(0, a), b) covers a then b. */
static uint32_t block_crc32(uint32_t crc, const uint8_t *data, size_t len)
{
	crc = ~crc;
	while (len-- > 0) {
		crc = crc_table[(crc ^ *data++) & 0xFFU] ^ (crc >> 8);
	}

	return ~crc;
}

/* Payload of a block being built, right behind its header. */
static uint32_t *block_payload(struct net_buf *buf)
{
	return (uint32_t *)(buf->data + BLOCK_HEADER_SIZE);
}

/* Fills in the header of a block whose payload is in place, and sizes it. */
static void block_seal(struct net_buf *buf, uint8_t flags, const struct sampling_block *blk)
{
	struct ppk2_block_header *h = (struct ppk2_block_header *)buf->data;
	size_t payload = 4U * blk->words;
	uint32_t crc;

	h->magic[0] = PPK2_BLOCK_MAGIC0;
	h->magic[1] = PPK2_BLOCK_MAGIC1;
	h->version = PPK2_BLOCK_VERSION;
	h->flags = flags;
	h->first = sys_cpu_to_le32(blk->first);
	h->count = sys_cpu_to_le16(blk->count);
	h->stream = stream_id;
	h->reserved = 0;
	h->current_base = sys_cpu_to_le16(blk->base[PPK2_FIELD_CURRENT]);
	h->voltage_base = sys_cpu_to_le16(blk->base[PPK2_FIELD_VOLTAGE]);
	h->range_base = (uint8_t)blk->base[PPK2_FIELD_RANGE];
	h->logic_base = (uint8_t)blk->base[PPK2_FIELD_LOGIC];
	h->widths_cv = blk->width[PPK2_FIELD_CURRENT] | (blk->width[PPK2_FIELD_VOLTAGE] << 4);
	h->widths_rl = blk->width[PPK2_FIELD_RANGE] | (blk->width[PPK2_FIELD_LOGIC] << 4);

	crc = block_crc32(0, buf->data, offsetof(struct ppk2_block_header, crc));
	crc = block_crc32(crc, (const uint8_t *)block_payload(buf), payload);
	h->crc = sys_cpu_to_le32(crc);

	net_buf_add(buf, BLOCK_HEADER_SIZE + payload);
}

/* ---- command intake ---------------------------------------------------- */

static void rx_handler(const uint8_t *data, size_t len)
{
	for (size_t k = 0; k < len; k++) {
		uint8_t b = data[k];

		if (!partial_active) {
			int8_t n = b < ARRAY_SIZE(cmd_arg_len) ? cmd_arg_len[b] : -1;

			if (n < 0) {
				stats.unknown_bytes++;
				continue;
			}

			partial.op = b;
			partial.len = 0;
			partial_active = true;
			if (n > 0) {
				continue;
			}
		} else {
			partial.arg[partial.len++] = b;
			if (partial.len < cmd_arg_len[partial.op]) {
				continue;
			}
		}

		partial_active = false;
		if (k_msgq_put(&cmd_q, &partial, K_NO_WAIT) != 0) {
			LOG_WRN("command queue full, dropped 0x%02x", partial.op);
		}
	}
}

static void link_handler(bool connected)
{
	struct cmd c = { .op = CMD_INTERNAL_LINK, .len = 1, .arg = { connected } };

	k_msgq_put(&cmd_q, &c, K_NO_WAIT);
}

/* ---- stream control ---------------------------------------------------- */

static void link_test_stop(void)
{
	link_test_active = false;
	while (link_test_busy) {
		k_sleep(K_MSEC(5));
	}
}

static void stream_start(void)
{
	if (streaming) {
		return;
	}

	link_test_stop();

	/* Set before the sampler runs, so the pump never mistakes the first
	 * samples of this stream for leftovers.
	 */
	stream_id++;
	streaming = true;

	int ret = sampling_start();

	if (ret < 0) {
		streaming = false;
		LOG_ERR("cannot start sampling: %d", ret);
		return;
	}

	LOG_INF("streaming");
}

/* Stops the stream and waits for its tail and final block to go out. */
static void stream_stop(void)
{
	if (!streaming) {
		return;
	}

	k_sem_reset(&flushed);
	sampling_stop();
	if (k_sem_take(&flushed, FLUSH_TIMEOUT) != 0) {
		stats.flush_timeouts++;
		LOG_WRN("stream tail not delivered");
		sampling_discard();
	}

	streaming = false;
	power_on_stream_stopped();
	LOG_INF("stopped");
}

/* The host went away: stop at once and drop whatever is still queued. */
static void stream_abort(void)
{
	link_test_stop();

	if (streaming) {
		streaming = false;
		sampling_stop();
		sampling_discard();
		power_on_stream_stopped();
		LOG_INF("stopped, host gone");
	}

	/* Anything left in the controller would reach the next reader of
	 * the port ahead of its metadata.
	 */
	k_mutex_lock(&tx_lock, K_FOREVER);
	usb_ppk_data_abort();
	k_mutex_unlock(&tx_lock);
}

static void send_text(const char *text, size_t len)
{
	k_mutex_lock(&tx_lock, K_FOREVER);
	while (len > 0) {
		size_t chunk = MIN(len, 1024U);
		int ret = usb_ppk_data_send((const uint8_t *)text, chunk, TX_TEXT_TIMEOUT);

		if (ret != 0) {
			stats.tx_failures++;
			LOG_WRN("metadata send failed: %d", ret);
			break;
		}
		text += chunk;
		len -= chunk;
	}
	k_mutex_unlock(&tx_lock);
}

static void handle_get_metadata(void)
{
	static char text[METADATA_TEXT_SIZE];

	/* The host expects only text until it has seen END. */
	link_test_stop();
	stream_stop();

	size_t len = metadata_format(text, sizeof(text));

	if (len == 0) {
		LOG_ERR("metadata does not fit its buffer");
		return;
	}

	send_text(text, len);
}

static void handle_set_user_gains(const uint8_t *arg)
{
	uint8_t range = arg[0];
	float gain;

	/* The app serialises the gain as a native little-endian float32. */
	memcpy(&gain, &arg[1], sizeof(gain));

	if (range >= PPK2_RANGE_COUNT || !isfinite(gain) || gain <= 0.0f) {
		LOG_WRN("rejected user gain %u", range);
		return;
	}

	metadata_get()->ug[range] = gain;
	metadata_save_deferred();
}

static void handle_link_test(uint8_t arg)
{
	uint8_t seconds = arg & ~LINK_TEST_PACK;

	if (seconds == 0) {
		link_test_stop();
		return;
	}
	if (streaming) {
		LOG_WRN("link test refused while streaming");
		return;
	}

	link_test_end = k_uptime_get() + 1000LL * MIN(seconds, LINK_TEST_MAX_SECONDS);
	link_test_pack = (arg & LINK_TEST_PACK) != 0;
	link_test_active = true;
}

static void dispatch(const struct cmd *c)
{
	stats.commands++;

	switch (c->op) {
	case CMD_INTERNAL_LINK:
		if (!c->arg[0]) {
			/* The DUT output is left as it was; the app turns it off
			 * itself on a clean close, and a USB hiccup should not cut
			 * the DUT's power.
			 */
			stream_abort();
		}
		break;

	case PPK2_CMD_AVERAGE_START:
		stream_start();
		break;

	case PPK2_CMD_AVERAGE_STOP:
		stream_stop();
		break;

	case PPK2_CMD_DEVICE_RUNNING_SET:
		power_set_output(c->arg[0] != 0);
		break;

	case PPK2_CMD_REGULATOR_SET:
		power_set_vdd((uint16_t)((c->arg[0] << 8) | c->arg[1]));
		break;

	case PPK2_CMD_SET_POWER_MODE:
		power_set_mode(c->arg[0]);
		break;

	case PPK2_CMD_GET_METADATA:
		handle_get_metadata();
		break;

	case PPK2_CMD_SET_USER_GAINS:
		handle_set_user_gains(c->arg);
		break;

	case PPK2_CMD_LINK_TEST:
		handle_link_test(c->arg[0]);
		break;

	case PPK2_CMD_RESET:
		stream_stop();
		power_set_output(false);
		k_sleep(K_MSEC(100));
		sys_reboot(SYS_REBOOT_COLD);
		break;

	default:
		/* PPK1-era commands: accepted for compatibility, no effect. */
		break;
	}
}

static void command_thread(void *p1, void *p2, void *p3)
{
	struct cmd c;

	ARG_UNUSED(p1);
	ARG_UNUSED(p2);
	ARG_UNUSED(p3);

	for (;;) {
		if (k_msgq_get(&cmd_q, &c, K_FOREVER) == 0) {
			dispatch(&c);
		}
	}
}

/* ---- sending ----------------------------------------------------------- */

/*
 * Sends the next block of the stream, packed straight into a USB buffer.
 * Returns false when there is nothing to do until more samples arrive.
 */
static bool pump_block(void)
{
	struct sampling_block blk;
	struct net_buf *buf;
	bool more = true;
	int err;

	k_mutex_lock(&tx_lock, K_FOREVER);

	if (!streaming || !sampling_block_ready()) {
		k_mutex_unlock(&tx_lock);
		return false;
	}

	buf = usb_ppk_data_alloc(BLOCK_BYTES_MAX, TX_BLOCK_TIMEOUT, &err);
	if (buf == NULL) {
		if (err == -EAGAIN) {
			/* The host is not reading; keep the samples and retry. */
			stats.tx_stalls++;
		} else {
			/* Nobody will read these. */
			stats.tx_failures++;
			sampling_discard();
			more = false;
		}
		k_mutex_unlock(&tx_lock);
		return more;
	}

	if (!sampling_take_block(block_payload(buf), &blk)) {
		usb_ppk_data_free(buf);
		k_mutex_unlock(&tx_lock);
		return sampling_block_ready();
	}

	uint8_t flags = (blk.overflow ? PPK2_BLOCK_OVERFLOW : 0U) |
			(blk.last ? PPK2_BLOCK_LAST : 0U) |
			(board_io_ext_usb_present() ? PPK2_BLOCK_EXT_USB : 0U);

	block_seal(buf, flags, &blk);

	size_t len = buf->len;

	if (usb_ppk_data_submit(buf) == 0) {
		sampling_count_block_sent();
		stats.bytes_sent += len;
	} else {
		/* Lost; the host sees the gap in the sample index. */
		stats.tx_failures++;
	}

	k_mutex_unlock(&tx_lock);
	return true;
}

/*
 * Sends full-width blocks as fast as the host takes them, so the result is
 * what the link sustains for the stream's worst case, independent of the
 * sampler; payload word k of a block is first + k. In pack mode the blocks
 * instead carry pseudo-random samples seeded by first + 1, packed like the
 * stream, for the host to check its decoder against.
 */
static void link_test_run(void)
{
	static const uint8_t full_width[PPK2_FIELD_COUNT] = PPK2_FIELD_BITS;
	struct sampling_block blk = {
		.count = PPK2_BLOCK_SAMPLES,
		.words = PPK2_BLOCK_PAYLOAD_WORDS(PPK2_BLOCK_SAMPLES, PPK2_SAMPLE_BITS_MAX),
	};
	struct net_buf *buf;
	int err;

	memcpy(blk.width, full_width, sizeof(blk.width));

	link_test_busy = true;

	while (link_test_active && k_uptime_get() < link_test_end) {
		k_mutex_lock(&tx_lock, K_FOREVER);
		buf = usb_ppk_data_alloc(BLOCK_BYTES_MAX, TX_BLOCK_TIMEOUT, &err);
		if (buf == NULL) {
			k_mutex_unlock(&tx_lock);
			if (err == -EAGAIN) {
				continue;
			}
			break;
		}

		uint32_t *payload = block_payload(buf);

		if (link_test_pack) {
			if (sampling_test_block(blk.first + 1U, payload, &blk) < 0) {
				/* The sampler has the ring (self-test). */
				usb_ppk_data_free(buf);
				k_mutex_unlock(&tx_lock);
				break;
			}
		} else {
			for (uint32_t k = 0; k < blk.words; k++) {
				payload[k] = blk.first + k;
			}
		}
		block_seal(buf, PPK2_BLOCK_TEST, &blk);
		if (usb_ppk_data_submit(buf) == 0) {
			stats.test_blocks++;
		}
		k_mutex_unlock(&tx_lock);
		blk.first += PPK2_BLOCK_SAMPLES;
	}

	k_mutex_lock(&tx_lock, K_FOREVER);
	buf = usb_ppk_data_alloc(BLOCK_HEADER_SIZE, TX_TEXT_TIMEOUT, &err);
	if (buf != NULL) {
		blk.count = 0;
		blk.words = 0;
		block_seal(buf, PPK2_BLOCK_TEST | PPK2_BLOCK_LAST, &blk);
		(void)usb_ppk_data_submit(buf);
	}
	k_mutex_unlock(&tx_lock);

	link_test_active = false;
	link_test_busy = false;
}

/*
 * Moves blocks from the sample ring to USB. After a stop it sends the tail
 * and the final block, then tells stream_stop() the stream is out.
 */
static void pump_thread(void *p1, void *p2, void *p3)
{
	ARG_UNUSED(p1);
	ARG_UNUSED(p2);
	ARG_UNUSED(p3);

	for (;;) {
		sampling_wait_block(K_MSEC(100));

		if (link_test_active) {
			link_test_run();
			continue;
		}

		while (pump_block()) {
		}

		if (streaming && sampling_drained()) {
			k_sem_give(&flushed);
		}
	}
}

K_THREAD_DEFINE(protocol_cmd_tid, 2048, command_thread, NULL, NULL, NULL,
		K_PRIO_PREEMPT(6), 0, 0);
K_THREAD_DEFINE(protocol_pump_tid, 2048, pump_thread, NULL, NULL, NULL,
		K_PRIO_PREEMPT(2), 0, 0);

int protocol_init(void)
{
	crc_init();
	usb_ppk_set_callbacks(rx_handler, link_handler);
	return 0;
}

bool protocol_streaming(void)
{
	return streaming;
}

void protocol_get_stats(struct protocol_stats *st)
{
	*st = stats;
}
