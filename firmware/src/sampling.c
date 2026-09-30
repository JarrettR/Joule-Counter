/*
 * SAADC front end: the current + DUT-voltage stream and the slow monitors.
 *
 * The stream is driven entirely in hardware: TIMER2 fires TASKS_SAMPLE once
 * per period over PPI. Two channels are enabled, so one SAMPLE task converts
 * the current (AIN7) and then VDUT (AIN4) back to back into a two-slot
 * EasyDMA buffer, and EVENTS_END fires once both have landed; END re-arms
 * the buffer via a second PPI channel, so the CPU only has to pick the pair
 * up. The END interrupt reads both results together with the range-switch
 * and logic-port pins and stores them in a ring buffer, from which the
 * protocol pump takes and packs blocks.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/irq.h>
#include <zephyr/sys/util.h>
#include <zephyr/logging/log.h>

#include <nrfx.h>
#include <hal/nrf_saadc.h>
#include <hal/nrf_timer.h>
#include <hal/nrf_ppi.h>
#include <hal/nrf_gpio.h>

#include "board_io.h"
#include "ppk2.h"
#include "sampling.h"

LOG_MODULE_REGISTER(sampling, CONFIG_LOG_DEFAULT_LEVEL);

#define RING_SIZE	CONFIG_PPK2_SAMPLE_RING_SAMPLES
#define RING_MASK	(RING_SIZE - 1)
BUILD_ASSERT((RING_SIZE & RING_MASK) == 0, "ring size must be a power of two");
BUILD_ASSERT(RING_SIZE >= 4 * PPK2_BLOCK_SAMPLES);
BUILD_ASSERT(PPK2_BLOCK_SAMPLES % 32U == 0, "blocks must start on a D7 bitmap word");

/*
 * How far the reader may trail the writer before it skips ahead: two blocks
 * short of a full ring, so the block being packed is not overwritten unless
 * the reader stalls for two more block times in the middle of packing it
 * (and that is detected).
 */
#define RING_READ_LIMIT	(RING_SIZE - 2 * PPK2_BLOCK_SAMPLES)

/* 16 MHz timer ticks per sample period, and where in the period to sample. */
#define TIMER_PERIOD_TICKS	(16000000U / PPK2_SAMPLE_RATE_HZ)
#define TIMER_SAMPLE_TICK	SAMPLING_SAMPLE_TICK
BUILD_ASSERT(TIMER_SAMPLE_TICK < TIMER_PERIOD_TICKS);

/* Fixed PPI channels; nothing else in this build uses the PPI. */
#define PPI_CH_SAMPLE		NRF_PPI_CHANNEL0
#define PPI_CH_REARM		NRF_PPI_CHANNEL1
#define PPI_CH_COUNT		NRF_PPI_CHANNEL2
#define PPI_CH_END_STAMP	NRF_PPI_CHANNEL3

/*
 * The END handler has 10 us to collect each result before the next one
 * overwrites it. At any kernel-visible priority it still queues behind
 * irq_lock() sections, and under streaming USB load those cost 41% of the
 * conversions on a real kit. So it runs zero-latency, above irq_lock(), and
 * therefore makes no kernel calls: block-ready signalling comes from TIMER3,
 * which counts END events in hardware and interrupts every block.
 */
#define IRQ_PRIO_SAADC		0
#define IRQ_PRIO_TIMER3		1

/*
 * Acquisition time code 7 is not in the product specification (documented
 * codes stop at 5 = 40 us) but it is what the PPK2's own firmware programs
 * for the current channel, and the calibration constants in every kit's
 * EEPROM were derived with it. The instrumentation amplifier output reaches
 * AIN7 through a 10 kOhm/1 nF filter, so a longer acquisition than the
 * 3 us minimum is also what the source impedance calls for.
 */
#define STREAM_TACQ_CODE	7U

/* VDUT reaches AIN4 through its 5:1 divider; start it on the same code as
 * the current channel and let the rate experiment say otherwise.
 */
#define STREAM_TACQ_V_CODE	7U

/* Scan slots: the SAADC converts enabled channels in index order. */
#define SCAN_CH_CURRENT		0
#define SCAN_CH_VOLTAGE		1
#define SCAN_CHANNELS		2

/*
 * Burst only belongs with oversampling (nrfx ties the two together): the
 * single-conversion path uses it so one SAMPLE task runs a whole 256x
 * sequence. The two-channel stream runs with it off — with burst set on two
 * scanned channels the SAADC returned the second channel's result in both
 * slots on this kit.
 */
#define CH_CONFIG(gain, tacq, burst)						\
	((SAADC_CH_CONFIG_RESP_Bypass << SAADC_CH_CONFIG_RESP_Pos) |		\
	 (SAADC_CH_CONFIG_RESN_Bypass << SAADC_CH_CONFIG_RESN_Pos) |		\
	 ((gain) << SAADC_CH_CONFIG_GAIN_Pos) |					\
	 (SAADC_CH_CONFIG_REFSEL_Internal << SAADC_CH_CONFIG_REFSEL_Pos) |	\
	 ((tacq) << SAADC_CH_CONFIG_TACQ_Pos) |					\
	 (SAADC_CH_CONFIG_MODE_Diff << SAADC_CH_CONFIG_MODE_Pos) |		\
	 ((burst) << SAADC_CH_CONFIG_BURST_Pos))

/* Every channel is measured differentially against the analog ground on AIN5. */
struct channel_desc {
	nrf_saadc_input_t input;
	uint32_t gain_code;
	float full_scale_mv;	/* 600 mV internal reference divided by the gain */
	float divider;		/* external attenuation to undo */
};

static const struct channel_desc channels[SAMPLING_CH_COUNT] = {
	[SAMPLING_CH_VSE_IA] = { NRF_SAADC_INPUT_AIN7, SAADC_CH_CONFIG_GAIN_Gain1_3, 1800.0f, 1.0f },
	[SAMPLING_CH_VREF_IA] = { NRF_SAADC_INPUT_AIN0, SAADC_CH_CONFIG_GAIN_Gain4, 150.0f, 1.0f },
	[SAMPLING_CH_VLDO] = { NRF_SAADC_INPUT_AIN1, SAADC_CH_CONFIG_GAIN_Gain1_3, 1800.0f, 5.0f },
	[SAMPLING_CH_VBB] = { NRF_SAADC_INPUT_AIN2, SAADC_CH_CONFIG_GAIN_Gain1_3, 1800.0f, 5.0f },
	[SAMPLING_CH_VIN] = { NRF_SAADC_INPUT_AIN3, SAADC_CH_CONFIG_GAIN_Gain1_3, 1800.0f, 5.0f },
	[SAMPLING_CH_VDUT] = { NRF_SAADC_INPUT_AIN4, SAADC_CH_CONFIG_GAIN_Gain1_3, 1800.0f, 5.0f },
	[SAMPLING_CH_NTC] = { NRF_SAADC_INPUT_AIN6, SAADC_CH_CONFIG_GAIN_Gain1_3, 1800.0f, 1.0f },
};

/*
 * Samples as the ISR stores them: current, range, voltage and logic D0..D6
 * in one word, and D7 in a bitmap. Stream index i lives at i & RING_MASK, so
 * one counter is both the ring position and the sample's slot in the
 * stream, and a block that starts on a block boundary never wraps. The
 * wire format is packed from this when a block is taken.
 */
#define RING_RANGE_POS		11U
#define RING_VOLTAGE_POS	14U
#define RING_LOGIC_POS		25U
#define RING_LOGIC_LOW_BITS	7U

static uint32_t ring_lo[RING_SIZE];
static uint32_t ring_hi[RING_SIZE / 32U];
static volatile uint32_t ring_wr;	/* next stream index the ISR writes */
static uint32_t ring_rd;		/* next stream index to be taken */
static bool ring_overflowed;		/* the next block follows a skip */
static bool ring_last_taken = true;	/* no stream has a final block pending */
/*
 * The stream in the ring has been stopped and ring_wr is final. Separate
 * from running, which is also false while a stream is still being started.
 */
static volatile bool ring_ended = true;
static K_MUTEX_DEFINE(ring_lock);

static volatile uint32_t isr_entries;
static volatile uint32_t isr_spurious;
static volatile uint32_t isr_switch_samples;
static uint8_t stream_tacq = STREAM_TACQ_CODE;
static uint8_t stream_tacq_v = STREAM_TACQ_V_CODE;
/* Sample period actually programmed; only the self-test changes it. */
static uint32_t period_ticks = TIMER_PERIOD_TICKS;

static volatile nrf_saadc_value_t adc_result[SCAN_CHANNELS];

static volatile bool running;
static struct sampling_metrics metrics;

static K_SEM_DEFINE(block_sem, 0, K_SEM_MAX_LIMIT);
static K_MUTEX_DEFINE(adc_lock);

/*
 * ISR diagnostics. TIMER3 counts END events in hardware; reading it on every
 * entry gives the exact number of ENDs since the previous entry, so ENDs the
 * handler never saw are counted rather than inferred. Run time is in 16 MHz
 * TIMER4 ticks (160 per sample).
 */
static volatile uint32_t isr_missed_ends;
static volatile uint32_t isr_max_end_gap;
static volatile uint32_t isr_max_run_ticks;
static uint32_t isr_last_end_count;

/* END-to-handler latency: TIMER4 free-runs at 16 MHz, PPI captures it into
 * CC0 on END and the handler captures CC1 on entry. Unwrapped 32-bit, so a
 * delay longer than one sample period shows as what it is.
 */
static volatile uint32_t isr_max_latency_ticks;
static volatile uint32_t isr_latency_hist[SAMPLING_LATENCY_BUCKETS];

/* Where in the sample period each scan ends (TIMER2 ticks). A scan that
 * started on time ends at a fixed phase; spread here means it did not.
 */
static volatile uint32_t isr_end_phase_min;
static volatile uint32_t isr_end_phase_max;

/* Positive half only, two LSBs dropped: the host multiplies by four, which
 * lands the value back in raw 14-bit counts.
 */
static ALWAYS_INLINE uint32_t adc_to_field(int32_t raw)
{
	return raw > 0 ? MIN((uint32_t)raw >> 2, PPK2_SAMPLE_VALUE_MAX) : 0U;
}

static ALWAYS_INLINE void ring_put(uint32_t idx, uint32_t lo, uint32_t hi_bit)
{
	uint32_t *hi = &ring_hi[(idx & RING_MASK) / 32U];
	uint32_t pos = idx % 32U;

	ring_lo[idx & RING_MASK] = lo;
	*hi = (*hi & ~BIT(pos)) | (hi_bit << pos);
}

/* Zero-latency: registers and plain memory only, nothing from the kernel. */
ISR_DIRECT_DECLARE(saadc_isr)
{
	/* When the scan ended, PPI captured TIMER4 into CC0 and the sample
	 * period's timer into CC2; only the entry and exit stamps cost the
	 * handler a capture.
	 */
	nrf_timer_task_trigger(NRF_TIMER4, NRF_TIMER_TASK_CAPTURE1);
	uint32_t t_in = nrf_timer_cc_get(NRF_TIMER4, NRF_TIMER_CC_CHANNEL1);
	uint32_t latency = t_in - nrf_timer_cc_get(NRF_TIMER4, NRF_TIMER_CC_CHANNEL0);
	uint32_t end_phase = nrf_timer_cc_get(NRF_TIMER2, NRF_TIMER_CC_CHANNEL2);
	uint32_t bucket = latency / 16U;	/* 1 us buckets */

	if (bucket >= SAMPLING_LATENCY_BUCKETS) {
		bucket = SAMPLING_LATENCY_BUCKETS - 1;
	}
	isr_latency_hist[bucket]++;
	if (latency > isr_max_latency_ticks) {
		isr_max_latency_ticks = latency;
	}

	if (end_phase < isr_end_phase_min) {
		isr_end_phase_min = end_phase;
	}
	if (end_phase > isr_end_phase_max) {
		isr_end_phase_max = end_phase;
	}

	nrf_timer_task_trigger(NRF_TIMER3, NRF_TIMER_TASK_CAPTURE1);
	uint32_t ends = nrf_timer_cc_get(NRF_TIMER3, NRF_TIMER_CC_CHANNEL1);
	uint32_t gap = ends - isr_last_end_count;

	isr_last_end_count = ends;
	isr_entries++;
	nrf_saadc_event_clear(NRF_SAADC, NRF_SAADC_EVENT_END);

	if (gap == 0) {
		/* No scan ended since the last entry: nothing new to read, and a
		 * sample written now would shift every later one by a slot.
		 */
		isr_spurious++;
		return 0;
	}

	/* The PPI re-arm has already restarted the DMA; both results are ours
	 * to read until the next scan lands, one period from now.
	 */
	int32_t raw_i = adc_result[SCAN_CH_CURRENT];
	int32_t raw_v = adc_result[SCAN_CH_VOLTAGE];
	uint32_t p0 = nrf_gpio_port_in_read(NRF_P0);
	uint32_t wr = ring_wr;

	if (gap > 1) {
		/* Scans that ended while this handler was held off were
		 * overwritten by the next one. They keep their slots, as
		 * placeholders, so every later sample keeps its time.
		 */
		uint32_t missed = gap - 1;

		isr_missed_ends += missed;
		if (gap > isr_max_end_gap) {
			isr_max_end_gap = gap;
		}
		if (missed > RING_SIZE) {
			/* Only the last lap can still be read. */
			wr += missed - RING_SIZE;
			missed = RING_SIZE;
		}
		while (missed-- > 0) {
			ring_put(wr++, PPK2_RANGE_MISSING << RING_RANGE_POS, 0);
		}
	}

	uint32_t sw = (p0 & 0x3U) | ((p0 >> 24) & 0xCU);
	uint32_t range = board_io_decode_range(sw);
	uint32_t logic = (p0 >> BOARD_P0_LOGIC_SHIFT) & 0xFFU;

	if (range == PPK2_RANGE_SWITCHING) {
		isr_switch_samples++;
	}

	/* D7 falls off the top of the low word and goes to the bitmap. */
	ring_put(wr, adc_to_field(raw_i) |
		     (range << RING_RANGE_POS) |
		     (adc_to_field(raw_v) << RING_VOLTAGE_POS) |
		     (logic << RING_LOGIC_POS),
		 logic >> RING_LOGIC_LOW_BITS);
	ring_wr = wr + 1;

	nrf_timer_task_trigger(NRF_TIMER4, NRF_TIMER_TASK_CAPTURE2);
	uint32_t run = nrf_timer_cc_get(NRF_TIMER4, NRF_TIMER_CC_CHANNEL2) - t_in;

	if (run > isr_max_run_ticks) {
		isr_max_run_ticks = run;
	}

	return 0;
}

/*
 * TIMER3 counts END events over PPI and reaches CC[0] every block; this is
 * the kernel-visible half of the sampling interrupt work.
 */
static void timer3_isr(const void *arg)
{
	ARG_UNUSED(arg);

	nrf_timer_event_clear(NRF_TIMER3, NRF_TIMER_EVENT_COMPARE0);
	nrf_timer_cc_set(NRF_TIMER3, NRF_TIMER_CC_CHANNEL0,
			 nrf_timer_cc_get(NRF_TIMER3, NRF_TIMER_CC_CHANNEL0) + PPK2_BLOCK_SAMPLES);
	k_sem_give(&block_sem);
}

static int wait_event(nrf_saadc_event_t event, uint32_t timeout_us)
{
	while (!nrf_saadc_event_check(NRF_SAADC, event)) {
		if (timeout_us == 0) {
			return -ETIMEDOUT;
		}
		k_busy_wait(1);
		timeout_us--;
	}

	nrf_saadc_event_clear(NRF_SAADC, event);
	return 0;
}

/*
 * nRF52840 anomaly 212: switching the SAADC from several channels to one
 * (the stream's scan to a monitor's burst conversion) can leave it broken.
 * Seen on this kit as a scan that converted one channel per SAMPLE task,
 * so END came at half rate with the same input in both slots, or with the
 * two slots swapped. The documented workaround power-cycles the peripheral
 * before every channel reconfiguration; three undocumented registers,
 * which hold the offset calibration, have to be carried across by hand.
 * Everything else is reconfigured by the caller.
 */
static void saadc_power_cycle(void)
{
	volatile uint32_t *const power = (volatile uint32_t *)0x40007FFCUL;
	volatile uint32_t *const cal = (volatile uint32_t *)0x40007640UL;
	uint32_t saved[3];

	if (!nrf52_errata_212()) {
		return;
	}

	for (int k = 0; k < 3; k++) {
		saved[k] = cal[k];
	}
	*power = 0;
	(void)*power;
	*power = 1;
	for (int k = 0; k < 3; k++) {
		cal[k] = saved[k];
	}
}

static void saadc_common_setup(void)
{
	nrf_saadc_disable(NRF_SAADC);
	saadc_power_cycle();
	nrf_saadc_int_disable(NRF_SAADC, 0xFFFFFFFFU);
	nrf_saadc_resolution_set(NRF_SAADC, NRF_SAADC_RESOLUTION_14BIT);
	nrf_saadc_continuous_mode_disable(NRF_SAADC);

	for (uint8_t ch = 0; ch < 8; ch++) {
		nrf_saadc_channel_input_set(NRF_SAADC, ch, NRF_SAADC_INPUT_DISABLED,
					    NRF_SAADC_INPUT_DISABLED);
	}

	nrf_saadc_event_clear(NRF_SAADC, NRF_SAADC_EVENT_STARTED);
	nrf_saadc_event_clear(NRF_SAADC, NRF_SAADC_EVENT_END);
	nrf_saadc_event_clear(NRF_SAADC, NRF_SAADC_EVENT_DONE);
	nrf_saadc_event_clear(NRF_SAADC, NRF_SAADC_EVENT_RESULTDONE);
	nrf_saadc_event_clear(NRF_SAADC, NRF_SAADC_EVENT_STOPPED);
}

/* Both stream channels, in scan order; one SAMPLE task converts them all. */
static void stream_channels_setup(void)
{
	const struct channel_desc *v = &channels[SAMPLING_CH_VDUT];

	NRF_SAADC->CH[SCAN_CH_CURRENT].CONFIG =
		CH_CONFIG(SAADC_CH_CONFIG_GAIN_Gain1_3, stream_tacq, SAADC_CH_CONFIG_BURST_Disabled);
	nrf_saadc_channel_input_set(NRF_SAADC, SCAN_CH_CURRENT,
				    NRF_SAADC_INPUT_AIN7, NRF_SAADC_INPUT_AIN5);

	NRF_SAADC->CH[SCAN_CH_VOLTAGE].CONFIG =
		CH_CONFIG(v->gain_code, stream_tacq_v, SAADC_CH_CONFIG_BURST_Disabled);
	nrf_saadc_channel_input_set(NRF_SAADC, SCAN_CH_VOLTAGE, v->input, NRF_SAADC_INPUT_AIN5);

	nrf_saadc_oversample_set(NRF_SAADC, NRF_SAADC_OVERSAMPLE_DISABLED);
}

static int saadc_calibrate_offset(void)
{
	nrf_saadc_event_clear(NRF_SAADC, NRF_SAADC_EVENT_CALIBRATEDONE);
	nrf_saadc_task_trigger(NRF_SAADC, NRF_SAADC_TASK_CALIBRATEOFFSET);

	return wait_event(NRF_SAADC_EVENT_CALIBRATEDONE, 10000);
}

static void timer_setup(void)
{
	nrf_timer_task_trigger(NRF_TIMER2, NRF_TIMER_TASK_STOP);
	nrf_timer_task_trigger(NRF_TIMER2, NRF_TIMER_TASK_CLEAR);
	nrf_timer_mode_set(NRF_TIMER2, NRF_TIMER_MODE_TIMER);
	nrf_timer_bit_width_set(NRF_TIMER2, NRF_TIMER_BIT_WIDTH_32);
	nrf_timer_prescaler_set(NRF_TIMER2, 0);
	nrf_timer_cc_set(NRF_TIMER2, NRF_TIMER_CC_CHANNEL0, TIMER_PERIOD_TICKS);
	nrf_timer_cc_set(NRF_TIMER2, NRF_TIMER_CC_CHANNEL1, TIMER_SAMPLE_TICK);
	nrf_timer_shorts_enable(NRF_TIMER2, NRF_TIMER_SHORT_COMPARE0_CLEAR_MASK);

	nrf_ppi_channel_endpoint_setup(NRF_PPI, PPI_CH_SAMPLE,
		nrf_timer_event_address_get(NRF_TIMER2, NRF_TIMER_EVENT_COMPARE1),
		nrf_saadc_task_address_get(NRF_SAADC, NRF_SAADC_TASK_SAMPLE));
	nrf_ppi_channel_endpoint_setup(NRF_PPI, PPI_CH_REARM,
		nrf_saadc_event_address_get(NRF_SAADC, NRF_SAADC_EVENT_END),
		nrf_saadc_task_address_get(NRF_SAADC, NRF_SAADC_TASK_START));

	/* TIMER3 counts END events in hardware, independent of the CPU, so a
	 * shortfall of interrupts against conversions is measurable.
	 */
	nrf_timer_task_trigger(NRF_TIMER3, NRF_TIMER_TASK_STOP);
	nrf_timer_task_trigger(NRF_TIMER3, NRF_TIMER_TASK_CLEAR);
	nrf_timer_mode_set(NRF_TIMER3, NRF_TIMER_MODE_COUNTER);
	nrf_timer_bit_width_set(NRF_TIMER3, NRF_TIMER_BIT_WIDTH_32);
	nrf_ppi_channel_endpoint_setup(NRF_PPI, PPI_CH_COUNT,
		nrf_saadc_event_address_get(NRF_SAADC, NRF_SAADC_EVENT_END),
		nrf_timer_task_address_get(NRF_TIMER3, NRF_TIMER_TASK_COUNT));

	/* TIMER4 timestamps each END for the latency measurement; the fork
	 * records where in the sample period it fell.
	 */
	nrf_timer_task_trigger(NRF_TIMER4, NRF_TIMER_TASK_STOP);
	nrf_timer_task_trigger(NRF_TIMER4, NRF_TIMER_TASK_CLEAR);
	nrf_timer_mode_set(NRF_TIMER4, NRF_TIMER_MODE_TIMER);
	nrf_timer_bit_width_set(NRF_TIMER4, NRF_TIMER_BIT_WIDTH_32);
	nrf_timer_prescaler_set(NRF_TIMER4, NRF_TIMER_FREQ_16MHz);
	nrf_ppi_channel_and_fork_endpoint_setup(NRF_PPI, PPI_CH_END_STAMP,
		nrf_saadc_event_address_get(NRF_SAADC, NRF_SAADC_EVENT_END),
		nrf_timer_task_address_get(NRF_TIMER4, NRF_TIMER_TASK_CAPTURE0),
		nrf_timer_task_address_get(NRF_TIMER2, NRF_TIMER_TASK_CAPTURE2));
}

static uint32_t end_event_count(void)
{
	nrf_timer_task_trigger(NRF_TIMER3, NRF_TIMER_TASK_CAPTURE0);
	return nrf_timer_cc_get(NRF_TIMER3, NRF_TIMER_CC_CHANNEL0);
}


int sampling_init(void)
{
	int ret;

	/* Cycle counter for the packing cost in the metrics. */
	CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
	DWT->CYCCNT = 0;
	DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;

	IRQ_DIRECT_CONNECT(SAADC_IRQn, IRQ_PRIO_SAADC, saadc_isr, IRQ_ZERO_LATENCY);
	IRQ_CONNECT(TIMER3_IRQn, IRQ_PRIO_TIMER3, timer3_isr, NULL, 0);

	saadc_common_setup();
	stream_channels_setup();
	nrf_saadc_enable(NRF_SAADC);

	ret = saadc_calibrate_offset();
	if (ret < 0) {
		LOG_WRN("offset calibration timed out");
	}

	nrf_saadc_disable(NRF_SAADC);
	timer_setup();

	return 0;
}

int sampling_start(void)
{
	int ret;

	k_mutex_lock(&adc_lock, K_FOREVER);

	if (running) {
		k_mutex_unlock(&adc_lock);
		return 0;
	}

	saadc_common_setup();
	stream_channels_setup();
	nrf_saadc_buffer_init(NRF_SAADC, (nrf_saadc_value_t *)adc_result, SCAN_CHANNELS);
	nrf_saadc_enable(NRF_SAADC);

	/* Every stream counts its slots from zero. The pump takes ring_lock
	 * for each block, so it never sees half of this reset.
	 */
	k_mutex_lock(&ring_lock, K_FOREVER);
	ring_wr = 0;
	ring_rd = 0;
	ring_overflowed = false;
	ring_last_taken = false;
	ring_ended = false;
	k_mutex_unlock(&ring_lock);

	isr_entries = 0;
	isr_spurious = 0;
	isr_switch_samples = 0;
	isr_missed_ends = 0;
	isr_max_end_gap = 0;
	isr_max_run_ticks = 0;
	isr_last_end_count = 0;
	isr_max_latency_ticks = 0;
	isr_end_phase_min = UINT32_MAX;
	isr_end_phase_max = 0;
	memset((void *)isr_latency_hist, 0, sizeof(isr_latency_hist));
	k_sem_reset(&block_sem);

	nrf_timer_task_trigger(NRF_TIMER4, NRF_TIMER_TASK_CLEAR);
	nrf_timer_task_trigger(NRF_TIMER4, NRF_TIMER_TASK_START);
	nrf_ppi_channel_enable(NRF_PPI, PPI_CH_END_STAMP);

	nrf_timer_task_trigger(NRF_TIMER3, NRF_TIMER_TASK_CLEAR);
	nrf_timer_cc_set(NRF_TIMER3, NRF_TIMER_CC_CHANNEL0, PPK2_BLOCK_SAMPLES);
	nrf_timer_event_clear(NRF_TIMER3, NRF_TIMER_EVENT_COMPARE0);
	nrf_timer_int_enable(NRF_TIMER3, NRF_TIMER_INT_COMPARE0_MASK);
	/* A compare or END that landed as the last stream stopped can still
	 * be pending; it must not fire into this one.
	 */
	NVIC_ClearPendingIRQ(TIMER3_IRQn);
	irq_enable(TIMER3_IRQn);
	nrf_timer_task_trigger(NRF_TIMER3, NRF_TIMER_TASK_START);

	nrf_saadc_int_enable(NRF_SAADC, NRF_SAADC_INT_END);
	NVIC_ClearPendingIRQ(SAADC_IRQn);
	irq_enable(SAADC_IRQn);

	nrf_saadc_task_trigger(NRF_SAADC, NRF_SAADC_TASK_START);
	ret = wait_event(NRF_SAADC_EVENT_STARTED, 1000);
	if (ret < 0) {
		LOG_ERR("SAADC did not start");
		irq_disable(SAADC_IRQn);
		nrf_saadc_disable(NRF_SAADC);
		k_mutex_unlock(&adc_lock);
		return ret;
	}

	nrf_ppi_channel_enable(NRF_PPI, PPI_CH_COUNT);
	nrf_ppi_channel_enable(NRF_PPI, PPI_CH_REARM);
	nrf_ppi_channel_enable(NRF_PPI, PPI_CH_SAMPLE);
	nrf_timer_cc_set(NRF_TIMER2, NRF_TIMER_CC_CHANNEL0, period_ticks);
	nrf_timer_task_trigger(NRF_TIMER2, NRF_TIMER_TASK_CLEAR);
	nrf_timer_task_trigger(NRF_TIMER2, NRF_TIMER_TASK_START);

	running = true;
	k_mutex_unlock(&adc_lock);

	return 0;
}

void sampling_stop(void)
{
	k_mutex_lock(&adc_lock, K_FOREVER);

	if (!running) {
		k_mutex_unlock(&adc_lock);
		return;
	}

	nrf_timer_task_trigger(NRF_TIMER2, NRF_TIMER_TASK_STOP);
	nrf_ppi_channel_disable(NRF_PPI, PPI_CH_SAMPLE);
	nrf_ppi_channel_disable(NRF_PPI, PPI_CH_REARM);

	nrf_saadc_int_disable(NRF_SAADC, NRF_SAADC_INT_END);
	irq_disable(SAADC_IRQn);

	nrf_saadc_event_clear(NRF_SAADC, NRF_SAADC_EVENT_STOPPED);
	nrf_saadc_task_trigger(NRF_SAADC, NRF_SAADC_TASK_STOP);
	wait_event(NRF_SAADC_EVENT_STOPPED, 1000);
	nrf_saadc_disable(NRF_SAADC);

	/* Leave the counters readable until the next start. */
	nrf_ppi_channel_disable(NRF_PPI, PPI_CH_COUNT);
	nrf_ppi_channel_disable(NRF_PPI, PPI_CH_END_STAMP);
	nrf_timer_int_disable(NRF_TIMER3, NRF_TIMER_INT_COMPARE0_MASK);
	irq_disable(TIMER3_IRQn);
	nrf_timer_task_trigger(NRF_TIMER3, NRF_TIMER_TASK_STOP);
	nrf_timer_task_trigger(NRF_TIMER4, NRF_TIMER_TASK_STOP);

	ring_ended = true;
	running = false;
	/* Wake the consumer so it can flush what is left in the ring. */
	k_sem_give(&block_sem);

	k_mutex_unlock(&adc_lock);
}

bool sampling_running(void)
{
	return running;
}

int sampling_wait_block(k_timeout_t timeout)
{
	return k_sem_take(&block_sem, timeout);
}

/* Skips ahead when the reader has fallen too far behind. Holds ring_lock. */
static uint32_t ring_catch_up(uint32_t wr)
{
	if (wr - ring_rd > RING_READ_LIMIT) {
		uint32_t to = ROUND_UP(wr - RING_READ_LIMIT, PPK2_BLOCK_SAMPLES);

		metrics.samples_dropped += to - ring_rd;
		metrics.overflows++;
		ring_rd = to;
		ring_overflowed = true;
	}

	return wr - ring_rd;
}

bool sampling_block_ready(void)
{
	bool ended = ring_ended;
	uint32_t used = ring_wr - ring_rd;

	return ended ? (used > 0 || !ring_last_taken) : used >= PPK2_BLOCK_SAMPLES;
}

/* Bits needed for values 0..spread. */
static inline uint8_t width_of(uint32_t spread)
{
	return spread > 0 ? (uint8_t)(32U - __builtin_clz(spread)) : 0U;
}

/*
 * Packs n samples from stream index start into payload as ppk2.h
 * describes: each field as its offset from the block minimum, in the bits
 * the block's spread needs. start is a multiple of 32, so each group of 32
 * samples shares one word of the D7 bitmap. Runs for every block of the
 * stream at 100 kHz, hence scalars throughout.
 */
static void pack_block(uint32_t start, uint32_t n, uint32_t *payload,
		       struct sampling_block *blk)
{
	const uint32_t *lo = &ring_lo[start & RING_MASK];
	const uint32_t *d7 = &ring_hi[(start & RING_MASK) / 32U];
	uint32_t c_min = UINT32_MAX, r_min = UINT32_MAX, v_min = UINT32_MAX, l_min = UINT32_MAX;
	uint32_t c_max = 0, r_max = 0, v_max = 0, l_max = 0;
	uint32_t t0 = DWT->CYCCNT;

	for (uint32_t g = 0; g < n; g += 32U) {
		uint32_t hw = d7[g / 32U];
		uint32_t end = MIN(g + 32U, n);

		for (uint32_t k = g; k < end; k++, hw >>= 1) {
			uint32_t w = lo[k];
			uint32_t c = w & PPK2_SAMPLE_VALUE_MAX;
			uint32_t r = (w >> RING_RANGE_POS) & 0x7U;
			uint32_t v = (w >> RING_VOLTAGE_POS) & PPK2_SAMPLE_VALUE_MAX;
			uint32_t l = (w >> RING_LOGIC_POS) | ((hw & 1U) << RING_LOGIC_LOW_BITS);

			c_min = MIN(c_min, c);
			c_max = MAX(c_max, c);
			r_min = MIN(r_min, r);
			r_max = MAX(r_max, r);
			v_min = MIN(v_min, v);
			v_max = MAX(v_max, v);
			l_min = MIN(l_min, l);
			l_max = MAX(l_max, l);
		}
	}

	if (n == 0) {
		c_min = r_min = v_min = l_min = 0;
	}

	uint32_t wc = width_of(c_max - c_min);
	uint32_t wr = width_of(r_max - r_min);
	uint32_t wv = width_of(v_max - v_min);
	uint32_t wl = width_of(l_max - l_min);
	uint32_t s_r = wc;
	uint32_t s_v = s_r + wr;
	uint32_t s_l = s_v + wv;
	uint32_t bits = s_l + wl;

	blk->base[PPK2_FIELD_CURRENT] = (uint16_t)c_min;
	blk->base[PPK2_FIELD_RANGE] = (uint16_t)r_min;
	blk->base[PPK2_FIELD_VOLTAGE] = (uint16_t)v_min;
	blk->base[PPK2_FIELD_LOGIC] = (uint16_t)l_min;
	blk->width[PPK2_FIELD_CURRENT] = (uint8_t)wc;
	blk->width[PPK2_FIELD_RANGE] = (uint8_t)wr;
	blk->width[PPK2_FIELD_VOLTAGE] = (uint8_t)wv;
	blk->width[PPK2_FIELD_LOGIC] = (uint8_t)wl;

	/* The first three fields fit 25 bits; only logic can push a sample
	 * past 32. The accumulator holds fewer than 32 unwritten bits, so it
	 * never needs more than 64.
	 */
	uint64_t acc = 0;
	uint32_t pending = 0;
	uint32_t *out = payload;

	for (uint32_t g = 0; bits > 0 && g < n; g += 32U) {
		uint32_t hw = d7[g / 32U];
		uint32_t end = MIN(g + 32U, n);

		for (uint32_t k = g; k < end; k++, hw >>= 1) {
			uint32_t w = lo[k];
			uint32_t l = (w >> RING_LOGIC_POS) | ((hw & 1U) << RING_LOGIC_LOW_BITS);
			uint32_t low = ((w & PPK2_SAMPLE_VALUE_MAX) - c_min) |
				       ((((w >> RING_RANGE_POS) & 0x7U) - r_min) << s_r) |
				       ((((w >> RING_VOLTAGE_POS) & PPK2_SAMPLE_VALUE_MAX) - v_min)
					<< s_v);

			acc |= ((uint64_t)low | ((uint64_t)(l - l_min) << s_l)) << pending;
			pending += bits;
			if (pending >= 32U) {
				*out++ = (uint32_t)acc;
				acc >>= 32;
				pending -= 32U;
				if (pending >= 32U) {
					*out++ = (uint32_t)acc;
					acc >>= 32;
					pending -= 32U;
				}
			}
		}
	}
	if (pending > 0) {
		*out++ = (uint32_t)acc;
	}

	blk->words = (uint16_t)(out - payload);

	uint32_t cycles = DWT->CYCCNT - t0;

	metrics.pack_cycles += cycles;
	metrics.pack_samples += n;
	metrics.pack_cycles_max = MAX(metrics.pack_cycles_max, cycles);
}

static uint32_t xorshift32(uint32_t *state)
{
	uint32_t x = *state;

	x ^= x << 13;
	x ^= x >> 17;
	x ^= x << 5;
	*state = x;
	return x;
}

int sampling_test_block(uint32_t seed, uint32_t *payload, struct sampling_block *blk)
{
	static const uint8_t full[PPK2_FIELD_COUNT] = PPK2_FIELD_BITS;
	uint32_t state = seed != 0 ? seed : 1U;
	uint32_t mask[PPK2_FIELD_COUNT];
	uint32_t base[PPK2_FIELD_COUNT];

	if (running) {
		return -EBUSY;
	}

	for (int j = 0; j < PPK2_FIELD_COUNT; j++) {
		mask[j] = BIT_MASK(xorshift32(&state) % (full[j] + 1U));
		base[j] = xorshift32(&state) & BIT_MASK(full[j]);
	}

	for (uint32_t k = 0; k < PPK2_BLOCK_SAMPLES; k++) {
		uint32_t f[PPK2_FIELD_COUNT];

		for (int j = 0; j < PPK2_FIELD_COUNT; j++) {
			f[j] = (base[j] & ~mask[j]) | (xorshift32(&state) & mask[j]);
		}
		ring_put(k, f[PPK2_FIELD_CURRENT] | (f[PPK2_FIELD_RANGE] << RING_RANGE_POS) |
			    (f[PPK2_FIELD_VOLTAGE] << RING_VOLTAGE_POS) |
			    (f[PPK2_FIELD_LOGIC] << RING_LOGIC_POS),
			 f[PPK2_FIELD_LOGIC] >> RING_LOGIC_LOW_BITS);
	}

	blk->count = PPK2_BLOCK_SAMPLES;
	pack_block(0, PPK2_BLOCK_SAMPLES, payload, blk);
	return 0;
}

bool sampling_take_block(uint32_t *payload, struct sampling_block *blk)
{
	k_mutex_lock(&ring_lock, K_FOREVER);

	/* Read ring_ended first: once it is set, ring_wr is final. */
	bool ended = ring_ended;
	uint32_t wr = ring_wr;
	uint32_t n = MIN(ring_catch_up(wr), PPK2_BLOCK_SAMPLES);

	if (ended ? (n == 0 && ring_last_taken) : n < PPK2_BLOCK_SAMPLES) {
		k_mutex_unlock(&ring_lock);
		return false;
	}

	/* ring_rd is block-aligned here, so a block never wraps: it starts at
	 * zero and only ever advances by whole blocks or skips to a block
	 * boundary, except for a stopped stream's short final block, after
	 * which nothing is taken.
	 */
	pack_block(ring_rd, n, payload, blk);

	/* If the writer lapped the region while it was packed, the result is
	 * garbage: skip it, and let the next call send what is current.
	 */
	if (ring_wr - ring_rd > RING_SIZE) {
		(void)ring_catch_up(ring_wr);
		k_mutex_unlock(&ring_lock);
		return false;
	}

	blk->first = ring_rd;
	blk->count = (uint16_t)n;
	blk->overflow = ring_overflowed;
	ring_overflowed = false;
	ring_rd += n;
	blk->last = ended && ring_rd == wr;
	if (blk->last) {
		ring_last_taken = true;
	}
	metrics.samples_emitted += n;

	k_mutex_unlock(&ring_lock);
	return true;
}

void sampling_discard(void)
{
	k_mutex_lock(&ring_lock, K_FOREVER);

	uint32_t from = ring_rd;

	if (!ring_ended) {
		/* Stay block-aligned; the partial block goes next time. */
		ring_rd = ROUND_DOWN(ring_wr, PPK2_BLOCK_SAMPLES);
	} else {
		ring_rd = ring_wr;
		ring_last_taken = true;
	}
	metrics.samples_dropped += ring_rd - from;

	k_mutex_unlock(&ring_lock);
}

bool sampling_drained(void)
{
	return ring_ended && ring_rd == ring_wr && ring_last_taken;
}

void sampling_get_metrics(struct sampling_metrics *m)
{
	*m = metrics;
	m->switch_samples = isr_switch_samples;
	m->end_events = end_event_count();
	m->isr_entries = isr_entries;
	m->isr_spurious = isr_spurious;
	m->isr_missed_ends = isr_missed_ends;
	m->isr_max_end_gap = isr_max_end_gap;
	m->isr_max_run_ticks = isr_max_run_ticks;
	m->isr_max_latency_ticks = isr_max_latency_ticks;
	m->isr_end_phase_min = isr_end_phase_min;
	m->isr_end_phase_max = isr_end_phase_max;
	memcpy(m->isr_latency_hist, (const void *)isr_latency_hist, sizeof(m->isr_latency_hist));
}

int sampling_selftest(uint32_t seconds, bool spin, uint32_t period, struct sampling_metrics *m)
{
	/* No faster than the production rate, and slow enough to be a test. */
	if (period < TIMER_PERIOD_TICKS || period > 16000U) {
		return -EINVAL;
	}
	period_ticks = period;

	int ret = sampling_start();

	if (ret < 0) {
		period_ticks = TIMER_PERIOD_TICKS;
		return ret;
	}
	if (spin) {
		/* Keep the CPU out of WFI for the whole run. */
		uint32_t start = k_uptime_get_32();

		while (k_uptime_get_32() - start < seconds * 1000U) {
			arch_nop();
		}
	} else {
		k_sleep(K_SECONDS(seconds));
	}
	sampling_stop();
	period_ticks = TIMER_PERIOD_TICKS;
	sampling_get_metrics(m);

	return 0;
}

int sampling_set_tacq(uint8_t code)
{
	if (code > 7) {
		return -EINVAL;
	}

	stream_tacq = code;
	return 0;
}

uint8_t sampling_get_tacq(void)
{
	return stream_tacq;
}

int sampling_set_tacq_v(uint8_t code)
{
	if (code > 7) {
		return -EINVAL;
	}

	stream_tacq_v = code;
	return 0;
}

uint8_t sampling_get_tacq_v(void)
{
	return stream_tacq_v;
}

#ifdef CONFIG_PPK2_STREAM_KEEPS_CPU_AWAKE
/*
 * Waking the Cortex-M4 from WFI takes 12.5 us on this kit (END-to-handler
 * latency histogram: about 1.2 us with the CPU awake, 12.5 us from idle, and
 * constant-latency mode only brings that to 11.5 us). That is longer than the
 * sample period, so an idle CPU straddles two conversions on every wake-up
 * and services only half of them; at 66 kHz and below nothing is lost. The
 * idle thread therefore spins instead of sleeping while the stream runs.
 */
bool z_arm_on_enter_cpu_idle(void)
{
	return !running;
}
#endif

void sampling_reset_metrics(void)
{
	memset(&metrics, 0, sizeof(metrics));
}

void sampling_count_block_sent(void)
{
	metrics.blocks_sent++;
}

static int single_conversion(const struct channel_desc *desc, nrf_saadc_oversample_t oversample,
			     int32_t *raw)
{
	volatile nrf_saadc_value_t value = 0;
	int ret;

	saadc_common_setup();
	NRF_SAADC->CH[0].CONFIG = CH_CONFIG(desc->gain_code, SAADC_CH_CONFIG_TACQ_40us,
					    SAADC_CH_CONFIG_BURST_Enabled);
	nrf_saadc_channel_input_set(NRF_SAADC, 0, desc->input, NRF_SAADC_INPUT_AIN5);
	nrf_saadc_oversample_set(NRF_SAADC, oversample);
	nrf_saadc_buffer_init(NRF_SAADC, (nrf_saadc_value_t *)&value, 1);
	nrf_saadc_enable(NRF_SAADC);

	nrf_saadc_task_trigger(NRF_SAADC, NRF_SAADC_TASK_START);
	ret = wait_event(NRF_SAADC_EVENT_STARTED, 1000);
	if (ret == 0) {
		/* With burst mode on, one SAMPLE task runs the whole
		 * oversampling sequence.
		 */
		nrf_saadc_task_trigger(NRF_SAADC, NRF_SAADC_TASK_SAMPLE);
		ret = wait_event(NRF_SAADC_EVENT_END, 30000);
	}

	nrf_saadc_task_trigger(NRF_SAADC, NRF_SAADC_TASK_STOP);
	wait_event(NRF_SAADC_EVENT_STOPPED, 1000);
	nrf_saadc_disable(NRF_SAADC);

	if (ret == 0) {
		*raw = value;
	}

	return ret;
}

int sampling_measure_raw(enum sampling_channel ch, unsigned int count, int32_t *raw_avg)
{
	int64_t sum = 0;
	int ret = 0;

	if (ch >= SAMPLING_CH_COUNT || count == 0) {
		return -EINVAL;
	}

	k_mutex_lock(&adc_lock, K_FOREVER);
	if (running) {
		k_mutex_unlock(&adc_lock);
		return -EBUSY;
	}

	for (unsigned int k = 0; k < count; k++) {
		int32_t raw;

		ret = single_conversion(&channels[ch], NRF_SAADC_OVERSAMPLE_DISABLED, &raw);
		if (ret < 0) {
			break;
		}
		sum += raw;
	}
	k_mutex_unlock(&adc_lock);

	if (ret == 0) {
		*raw_avg = (int32_t)(sum / (int64_t)count);
	}

	return ret;
}

void sampling_voltage_scale(float *full_scale_mv, float *divider)
{
	*full_scale_mv = channels[SAMPLING_CH_VDUT].full_scale_mv;
	*divider = channels[SAMPLING_CH_VDUT].divider;
}

int sampling_measure_mv(enum sampling_channel ch, float *mv)
{
	int32_t raw;
	int ret;

	if (ch >= SAMPLING_CH_COUNT) {
		return -EINVAL;
	}

	k_mutex_lock(&adc_lock, K_FOREVER);
	if (running) {
		k_mutex_unlock(&adc_lock);
		return -EBUSY;
	}
	ret = single_conversion(&channels[ch], NRF_SAADC_OVERSAMPLE_256X, &raw);
	k_mutex_unlock(&adc_lock);

	if (ret < 0) {
		return ret;
	}

	/* Differential 14-bit: 13 bits of magnitude per polarity. */
	*mv = (float)raw * channels[ch].full_scale_mv / 8192.0f * channels[ch].divider;

	return 0;
}
