/*
 * Definitions shared across the PPK2 firmware.
 *
 * The wire format here is shared with the Joule-Counter desktop app
 * (Joule-Counter/src/device/blockParser.ts, serialDevice.ts) and with
 * tools/ppk_protocol.py; change them together.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#ifndef PPK2_H_
#define PPK2_H_

#include <stdint.h>

#include <zephyr/sys/util.h>

/*
 * One SAADC scan of both channels per period. 100 kHz is where the scan
 * tops out (two conversions in 10 us); the packed stream below carries it
 * at about 415 kB/s, the same link load as the stock one-word format.
 */
#define PPK2_SAMPLE_RATE_HZ	100000U
#define PPK2_BLOCK_SAMPLES	512U
#define PPK2_RANGE_COUNT	5U

/* Range field values other than 0..4. */
#define PPK2_RANGE_MISSING	6U	/* a conversion the sampler never saw */
#define PPK2_RANGE_SWITCHING	7U	/* the switches were between two ranges */

/*
 * The stream is a sequence of blocks, one USB transfer each: a 24-byte
 * struct ppk2_block_header, then the block's samples as one bit stream.
 *
 * A sample has four fields, all of them information:
 *
 *   current  0..2047  the 14-bit differential SAADC result shifted right by
 *                     two, clamped. The host multiplies it back by four, so
 *                     the calibration constants in the EEPROM are in raw
 *                     14-bit counts.
 *   range    0..7     0..4, PPK2_RANGE_SWITCHING or PPK2_RANGE_MISSING.
 *   voltage  0..2047  VDUT, same convention as the current (uncalibrated
 *                     linear divider/gain maths on the host).
 *   logic    0..255   logic port D0..D7.
 *
 * Each block stores every field as its offset from the block's smallest
 * value (base), in just enough bits for the block's spread (width): a quiet
 * signal needs a few bits a sample, a busy one at most 11 + 3 + 11 + 8 = 33,
 * which bounds the link load. Sample k occupies bits k*W .. k*W+W-1 of the
 * payload, W being the sum of the widths, fields in the order above, least
 * significant bit first, in 32-bit little-endian words zero-padded at the
 * end.
 *
 * Every conversion slot of a stream has an index, counting from zero at
 * AverageStart; the header names the index of the block's first sample and
 * the samples of a block are consecutive slots. Anything the device could
 * not deliver therefore shows up on the host as a gap between blocks, of
 * exactly the right length, and switching or missed conversions keep their
 * slot, so the time base never drifts.
 */
#define PPK2_SAMPLE_VALUE_MAX	0x7FFU

enum ppk2_field {
	PPK2_FIELD_CURRENT,
	PPK2_FIELD_RANGE,
	PPK2_FIELD_VOLTAGE,
	PPK2_FIELD_LOGIC,
	PPK2_FIELD_COUNT,
};

/* Width of each field at full resolution. */
#define PPK2_FIELD_BITS		{ 11U, 3U, 11U, 8U }
#define PPK2_SAMPLE_BITS_MAX	33U

#define PPK2_BLOCK_MAGIC0	'J'
#define PPK2_BLOCK_MAGIC1	'C'
#define PPK2_BLOCK_VERSION	1U

/* Block header flags. */
#define PPK2_BLOCK_EXT_USB	BIT(0)	/* J1 VBUS present when the block was sent */
#define PPK2_BLOCK_LAST		BIT(1)	/* the stream stopped; nothing follows */
#define PPK2_BLOCK_OVERFLOW	BIT(2)	/* the gap before this block is a ring overflow */
#define PPK2_BLOCK_TEST		BIT(3)	/* link test pattern, not measurements */

struct ppk2_block_header {
	uint8_t magic[2];
	uint8_t version;
	uint8_t flags;
	uint32_t first;		/* stream index of the first sample */
	uint16_t count;		/* samples in this block, 0..PPK2_BLOCK_SAMPLES */
	uint8_t stream;		/* changes with every AverageStart */
	uint8_t reserved;
	uint16_t current_base;
	uint16_t voltage_base;
	uint8_t range_base;
	uint8_t logic_base;
	uint8_t widths_cv;	/* current width | voltage width << 4 */
	uint8_t widths_rl;	/* range width | logic width << 4 */
	uint32_t crc;		/* CRC-32 (zlib) of bytes 0..19, then the payload */
} __packed;

BUILD_ASSERT(sizeof(struct ppk2_block_header) == 24);

#define PPK2_BLOCK_PAYLOAD_WORDS(n, bits)	DIV_ROUND_UP((n) * (bits), 32U)
#define PPK2_BLOCK_BYTES_MAX	(sizeof(struct ppk2_block_header) + \
				 4U * PPK2_BLOCK_PAYLOAD_WORDS(PPK2_BLOCK_SAMPLES, \
							       PPK2_SAMPLE_BITS_MAX))

enum ppk2_mode {
	PPK2_MODE_AMPERE = 1,
	PPK2_MODE_SOURCE = 2,
};

/* Commands the host may send on the data port, one opcode byte each. */
enum ppk2_cmd {
	PPK2_CMD_TRIGGER_SET		= 0x01,
	PPK2_CMD_AVG_NUM_SET		= 0x02,
	PPK2_CMD_TRIGGER_WINDOW_SET	= 0x03,
	PPK2_CMD_TRIGGER_INTERVAL_SET	= 0x04,
	PPK2_CMD_TRIGGER_SINGLE_SET	= 0x05,
	PPK2_CMD_AVERAGE_START		= 0x06,
	PPK2_CMD_AVERAGE_STOP		= 0x07,
	PPK2_CMD_RANGE_SET		= 0x08,
	PPK2_CMD_LCD_SET		= 0x09,
	PPK2_CMD_TRIGGER_STOP		= 0x0A,
	PPK2_CMD_DEVICE_RUNNING_SET	= 0x0C,
	PPK2_CMD_REGULATOR_SET		= 0x0D,
	PPK2_CMD_SWITCH_POINT_DOWN	= 0x0E,
	PPK2_CMD_SWITCH_POINT_UP	= 0x0F,
	PPK2_CMD_SET_POWER_MODE		= 0x11,
	PPK2_CMD_RES_USER_SET		= 0x12,
	PPK2_CMD_SPIKE_FILTERING_ON	= 0x15,
	PPK2_CMD_SPIKE_FILTERING_OFF	= 0x16,
	PPK2_CMD_GET_METADATA		= 0x19,
	PPK2_CMD_RESET			= 0x20,
	PPK2_CMD_SET_USER_GAINS		= 0x25,
	PPK2_CMD_LINK_TEST		= 0x30,
};

#endif /* PPK2_H_ */
