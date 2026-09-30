/*
 * SAADC front end: the current + DUT-voltage stream and the slow monitors.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#ifndef SAMPLING_H_
#define SAMPLING_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <zephyr/kernel.h>

#include "ppk2.h"

/* 16 MHz timer tick within each sample period at which the scan is triggered. */
#define SAMPLING_SAMPLE_TICK	112U

/* END-to-handler latency histogram, 1 us per bucket, last bucket open-ended. */
#define SAMPLING_LATENCY_BUCKETS	24

struct sampling_metrics {
	/* Samples handed to the host, and samples lost to ring overflow. */
	uint32_t samples_emitted;
	uint32_t samples_dropped;
	uint32_t overflows;
	/* Samples taken while the range switches were in transition. */
	uint32_t switch_samples;
	/* CPU cycles spent packing blocks, in total and for the worst block. */
	uint64_t pack_cycles;
	uint32_t pack_samples;
	uint32_t pack_cycles_max;
	uint32_t blocks_sent;
	/* SAADC END events counted in hardware (TIMER3) since the last start. */
	uint32_t end_events;
	/* Times the END interrupt actually ran. Fewer than end_events means
	 * conversions were lost to interrupt latency.
	 */
	uint32_t isr_entries;
	/* Entries that found no new scan and were ignored. */
	uint32_t isr_spurious;
	/* END events that passed between consecutive ISR entries without one
	 * of their own, and the largest such run.
	 */
	uint32_t isr_missed_ends;
	uint32_t isr_max_end_gap;
	/* Longest handler run seen, in 16 MHz ticks (160 per sample). */
	uint32_t isr_max_run_ticks;
	/* END event to handler entry, 16 MHz ticks, and its distribution. */
	uint32_t isr_max_latency_ticks;
	/* Earliest and latest scan end within the sample period, 16 MHz ticks
	 * after the period starts (SAMPLE fires at SAMPLING_SAMPLE_TICK).
	 */
	uint32_t isr_end_phase_min;
	uint32_t isr_end_phase_max;
	uint32_t isr_latency_hist[SAMPLING_LATENCY_BUCKETS];
};

/* Runs the sampler with nothing consuming the stream, then reports metrics.
 * With spin set the calling thread busy-waits instead of sleeping, which
 * keeps the CPU out of WFI for the duration. period is the sample period in
 * 16 MHz ticks (160 for the production rate).
 */
int sampling_selftest(uint32_t seconds, bool spin, uint32_t period, struct sampling_metrics *m);

enum sampling_channel {
	SAMPLING_CH_VSE_IA,	/* AIN7, instrumentation amplifier output */
	SAMPLING_CH_VREF_IA,	/* AIN0, instrumentation amplifier reference */
	SAMPLING_CH_VLDO,	/* AIN1, LDO output, /5 */
	SAMPLING_CH_VBB,	/* AIN2, buck-boost output, /5 */
	SAMPLING_CH_VIN,	/* AIN3, VIN terminal, /5 */
	SAMPLING_CH_VDUT,	/* AIN4, VDUT+, /5 */
	SAMPLING_CH_NTC,	/* AIN6, thermistor divider */
	SAMPLING_CH_COUNT,
};

int sampling_init(void);

int sampling_start(void);
void sampling_stop(void);
bool sampling_running(void);

/* Blocks until a block-sized run of samples is likely available. */
int sampling_wait_block(k_timeout_t timeout);

/* A block taken by sampling_take_block(): where it sits in the stream and
 * how its payload is packed (see ppk2.h).
 */
struct sampling_block {
	uint32_t first;		/* stream index of the first sample */
	uint16_t count;
	bool overflow;		/* samples right before this block were lost */
	bool last;		/* the stream has stopped; nothing follows */
	uint16_t base[PPK2_FIELD_COUNT];
	uint8_t width[PPK2_FIELD_COUNT];
	uint16_t words;		/* payload length in 32-bit words */
};

/*
 * True when sampling_take_block() has something to return: a full block
 * while the stream runs, the remainder and the final marker once it stopped.
 */
bool sampling_block_ready(void);

/*
 * Packs the next block into payload, which must hold
 * PPK2_BLOCK_PAYLOAD_WORDS(PPK2_BLOCK_SAMPLES, PPK2_SAMPLE_BITS_MAX) words.
 * When the reader has fallen too far behind, skips ahead first and flags
 * the block. Returns false if there is nothing to take; a stopped stream
 * yields one final block with last set, possibly empty.
 */
bool sampling_take_block(uint32_t *payload, struct sampling_block *blk);

/*
 * Packs a block of pseudo-random samples, seeded by seed, the way stream
 * blocks are packed, so a host can check the packing against its own copy
 * of the generator. Uses the ring, so only while no stream runs.
 */
int sampling_test_block(uint32_t seed, uint32_t *payload, struct sampling_block *blk);

/* Drops everything not taken yet, final marker included. */
void sampling_discard(void);

/* The stream has stopped and everything, final marker included, was taken. */
bool sampling_drained(void);

void sampling_get_metrics(struct sampling_metrics *m);
void sampling_reset_metrics(void);
void sampling_count_block_sent(void);

/* SAADC acquisition-time code for the stream (CONFIG.TACQ, 0..7). Takes
 * effect at the next start. Exposed for experiments; see STREAM_TACQ_CODE.
 */
int sampling_set_tacq(uint8_t code);
uint8_t sampling_get_tacq(void);

/* Same, for the voltage channel of the stream. */
int sampling_set_tacq_v(uint8_t code);
uint8_t sampling_get_tacq_v(void);

/*
 * One 256x oversampled conversion. Only while the stream is stopped.
 * The result is the voltage at the measured node, dividers included.
 */
int sampling_measure_mv(enum sampling_channel ch, float *mv);

/* Averaged raw 14-bit differential reading, for calibration work. */
int sampling_measure_raw(enum sampling_channel ch, unsigned int count, int32_t *raw_avg);

/* The stream's voltage word scale: mV = raw * full_scale_mv / 8192 * divider. */
void sampling_voltage_scale(float *full_scale_mv, float *divider);

#endif /* SAMPLING_H_ */
