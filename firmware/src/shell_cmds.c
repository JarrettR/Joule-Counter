/*
 * Maintenance shell on the second serial port.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/shell/shell.h>

#include "board_io.h"
#include "dfu.h"
#include "metadata.h"
#include "power.h"
#include "ppk2.h"
#include "protocol.h"
#include "sampling.h"

static void print_latency(const struct shell *sh, const struct sampling_metrics *sm);

static int cmd_status(const struct shell *sh, size_t argc, char **argv)
{
	struct power_status ps;
	struct sampling_metrics sm;
	struct protocol_stats st;
	bool streaming = protocol_streaming();

	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	power_get_status(&ps, !streaming);
	sampling_get_metrics(&sm);
	protocol_get_stats(&st);

	shell_print(sh, "mode      %s", ps.mode == PPK2_MODE_SOURCE ? "source" : "ampere");
	shell_print(sh, "vdd       %u mV%s", ps.vdd_mv, ps.retune_pending ? " (retune pending)" : "");
	shell_print(sh, "output    %s", ps.output_on ? "on" : "off");
	shell_print(sh, "ext usb   %s", ps.ext_usb ? "present" : "absent");
	shell_print(sh, "wipers    ia=%u ldo=%u bb=%u", ps.ia_code, ps.ldo_code, ps.bb_code);
	shell_print(sh, "range     %u", board_io_read_range());
	shell_print(sh, "calibrated %s", metadata_is_calibrated() ? "yes" : "no");
	if (!streaming) {
		shell_print(sh, "monitors  vldo=%.0f vbb=%.0f vin=%.0f vdut=%.0f mV",
			    (double)ps.vldo_mv, (double)ps.vbb_mv, (double)ps.vin_mv,
			    (double)ps.vdut_mv);
	} else {
		shell_print(sh, "monitors  unavailable while streaming");
	}
	shell_print(sh, "stream    %s, %u samples in %u blocks, %u bytes sent",
		    streaming ? "running" : "stopped", sm.samples_emitted, sm.blocks_sent,
		    st.bytes_sent);
	shell_print(sh, "adc       %u END events (I+V scans), %u ISR entries (%u spurious), "
		    "tacq I=%u V=%u",
		    sm.end_events, sm.isr_entries, sm.isr_spurious, sampling_get_tacq(),
		    sampling_get_tacq_v());
	shell_print(sh, "isr       %u ENDs missed, worst gap %u ENDs, worst run %u ticks (%u/sample)",
		    sm.isr_missed_ends, sm.isr_max_end_gap, sm.isr_max_run_ticks,
		    16000000U / PPK2_SAMPLE_RATE_HZ);
	print_latency(sh, &sm);
	shell_print(sh, "switching %u samples (sent as range %u)",
		    sm.switch_samples, PPK2_RANGE_SWITCHING);
	if (sm.pack_samples > 0) {
		shell_print(sh, "packing   %u cycles/sample, worst block %u us",
			    (uint32_t)(sm.pack_cycles / sm.pack_samples),
			    sm.pack_cycles_max / (SystemCoreClock / 1000000U));
	}
	shell_print(sh, "lost      %u samples in %u ring overflows, %u tx failures, "
		    "%u flush timeouts",
		    sm.samples_dropped, sm.overflows, st.tx_failures, st.flush_timeouts);
	shell_print(sh, "usb       %u waits for a free transfer slot timed out, %u test blocks",
		    st.tx_stalls, st.test_blocks);
	shell_print(sh, "commands  %u handled, %u unknown bytes", st.commands, st.unknown_bytes);

	return 0;
}

/* ---- metadata ---------------------------------------------------------- */

static int cmd_meta_read(const struct shell *sh, size_t argc, char **argv)
{
	static char text[METADATA_TEXT_SIZE];

	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	if (metadata_format(text, sizeof(text)) == 0) {
		shell_error(sh, "format failed");
		return -EIO;
	}

	shell_print(sh, "%s", text);
	return 0;
}

static int cmd_meta_raw(const struct shell *sh, size_t argc, char **argv)
{
	uint8_t buf[16];
	size_t offset = argc > 1 ? strtoul(argv[1], NULL, 0) : 0;
	size_t len = argc > 2 ? strtoul(argv[2], NULL, 0) : 160;

	while (len > 0) {
		size_t n = MIN(len, sizeof(buf));
		int ret = metadata_raw_read(offset, buf, n);

		if (ret < 0) {
			shell_error(sh, "read failed: %d", ret);
			return ret;
		}

		shell_fprintf(sh, SHELL_NORMAL, "%04x:", (unsigned int)offset);
		for (size_t k = 0; k < n; k++) {
			shell_fprintf(sh, SHELL_NORMAL, " %02x", buf[k]);
		}
		shell_fprintf(sh, SHELL_NORMAL, "\n");

		offset += n;
		len -= n;
	}

	return 0;
}

static int cmd_meta_set(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);

	int ret = metadata_set(argv[1], argv[2]);

	if (ret < 0) {
		shell_error(sh, "unknown key or bad value");
		return ret;
	}

	shell_print(sh, "%s set (in RAM; 'ppk meta save' to persist)", argv[1]);
	return 0;
}

static int cmd_meta_save(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	int ret = metadata_save();

	if (ret < 0) {
		shell_error(sh, "save failed: %d", ret);
	} else {
		shell_print(sh, "saved");
	}

	return ret;
}

static int cmd_meta_defaults(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	metadata_load_defaults();
	shell_print(sh, "defaults loaded (in RAM)");
	return 0;
}

static int cmd_meta_backup(const struct shell *sh, size_t argc, char **argv)
{
	int ret;

	ARG_UNUSED(argc);

	if (strcmp(argv[1], "write") == 0) {
		ret = metadata_backup_write();
	} else if (strcmp(argv[1], "check") == 0) {
		ret = metadata_backup_valid();
		shell_print(sh, "backup is %s", ret == 0 ? "valid" : "not valid");
		return 0;
	} else if (strcmp(argv[1], "restore") == 0) {
		ret = metadata_backup_restore();
	} else {
		shell_error(sh, "write | check | restore");
		return -EINVAL;
	}

	if (ret < 0) {
		shell_error(sh, "failed: %d", ret);
	} else {
		shell_print(sh, "ok");
	}

	return ret;
}

/* ---- power ------------------------------------------------------------- */

static int cmd_power_mode(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);

	uint8_t mode = strcmp(argv[1], "source") == 0 ? PPK2_MODE_SOURCE :
		       strcmp(argv[1], "ampere") == 0 ? PPK2_MODE_AMPERE :
		       (uint8_t)strtoul(argv[1], NULL, 0);
	int ret = power_set_mode(mode);

	if (ret < 0) {
		shell_error(sh, "failed: %d", ret);
	}

	return ret;
}

static int cmd_power_vdd(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);

	int ret = power_set_vdd((uint16_t)strtoul(argv[1], NULL, 0));

	if (ret < 0) {
		shell_error(sh, "failed: %d", ret);
	}

	return ret;
}

static int cmd_power_out(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);

	int ret = power_set_output(strtoul(argv[1], NULL, 0) != 0);

	if (ret < 0) {
		shell_error(sh, "failed: %d", ret);
	}

	return ret;
}

static int cmd_power_ia(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);

	uint16_t code = (uint16_t)strtoul(argv[1], NULL, 0);
	int ret = power_set_ia_code(code);

	if (ret < 0) {
		shell_error(sh, "failed: %d", ret);
		return ret;
	}

	metadata_get()->ia = code;
	shell_print(sh, "IA wiper %u (in RAM; 'ppk meta save' to persist)", code);
	return 0;
}

static int cmd_power_ia_trim(const struct shell *sh, size_t argc, char **argv)
{
	int32_t target = argc > 1 ? strtol(argv[1], NULL, 0) :
			 (int32_t)lroundf(metadata_get()->o[0]);
	uint16_t code;

	if (protocol_streaming()) {
		shell_error(sh, "stop streaming first");
		return -EBUSY;
	}

	int ret = power_trim_ia(target, &code);

	if (ret < 0) {
		shell_error(sh, "trim failed: %d", ret);
		return ret;
	}

	metadata_get()->ia = code;
	shell_print(sh, "IA wiper trimmed to %u for target %d (in RAM; 'ppk meta save' to persist)",
		    code, target);
	return 0;
}

/* ---- calibration ------------------------------------------------------- */

static int cmd_cal_load(const struct shell *sh, size_t argc, char **argv)
{
	static const struct {
		const char *name;
		enum board_cal_load load;
	} loads[] = {
		{ "100k", BOARD_CAL_100K }, { "10k", BOARD_CAL_10K },
		{ "1k", BOARD_CAL_1K }, { "100", BOARD_CAL_100 }, { "off", BOARD_CAL_OFF },
	};

	ARG_UNUSED(argc);

	for (size_t k = 0; k < ARRAY_SIZE(loads); k++) {
		if (strcmp(argv[1], loads[k].name) == 0) {
			return board_io_set_cal_load(loads[k].load);
		}
	}

	shell_error(sh, "100k | 10k | 1k | 100 | off");
	return -EINVAL;
}

static int cmd_cal_measure(const struct shell *sh, size_t argc, char **argv)
{
	static const char *const ch_names[SAMPLING_CH_COUNT] = {
		[SAMPLING_CH_VSE_IA] = "vse", [SAMPLING_CH_VREF_IA] = "vref",
		[SAMPLING_CH_VLDO] = "vldo", [SAMPLING_CH_VBB] = "vbb",
		[SAMPLING_CH_VIN] = "vin", [SAMPLING_CH_VDUT] = "vdut",
		[SAMPLING_CH_NTC] = "ntc",
	};
	unsigned int count = argc > 1 ? strtoul(argv[1], NULL, 0) : 64;
	enum sampling_channel ch = SAMPLING_CH_VSE_IA;
	int32_t raw;
	float vdut;
	int ret;

	if (argc > 2) {
		for (ch = 0; ch < SAMPLING_CH_COUNT; ch++) {
			if (strcmp(argv[2], ch_names[ch]) == 0) {
				break;
			}
		}
		if (ch == SAMPLING_CH_COUNT) {
			shell_error(sh, "channel: vse|vref|vldo|vbb|vin|vdut|ntc");
			return -EINVAL;
		}
	}

	if (protocol_streaming()) {
		shell_error(sh, "stop streaming first");
		return -EBUSY;
	}

	ret = sampling_measure_raw(ch, count, &raw);
	if (ret == 0) {
		ret = sampling_measure_mv(SAMPLING_CH_VDUT, &vdut);
	}
	if (ret < 0) {
		shell_error(sh, "measure failed: %d", ret);
		return ret;
	}

	shell_print(sh, "range %u  %s adc %d (avg of %u)  vdut %.1f mV",
		    board_io_read_range(), ch_names[ch], raw, count, (double)vdut);
	return 0;
}

/* ---- sampling ---------------------------------------------------------- */

static void print_latency(const struct shell *sh, const struct sampling_metrics *sm)
{
	if (sm->isr_end_phase_min <= sm->isr_end_phase_max) {
		shell_print(sh, "scan end  ticks %u..%u of the period (SAMPLE at %u)",
			    sm->isr_end_phase_min, sm->isr_end_phase_max, SAMPLING_SAMPLE_TICK);
	}
	shell_fprintf(sh, SHELL_NORMAL, "latency   END->ISR worst %u.%02u us; per us:",
		      sm->isr_max_latency_ticks / 16U,
		      (sm->isr_max_latency_ticks % 16U) * 100U / 16U);
	for (int i = 0; i < SAMPLING_LATENCY_BUCKETS; i++) {
		if (sm->isr_latency_hist[i] != 0) {
			shell_fprintf(sh, SHELL_NORMAL, " [%d%s]=%u", i,
				      i == SAMPLING_LATENCY_BUCKETS - 1 ? "+" : "",
				      sm->isr_latency_hist[i]);
		}
	}
	shell_fprintf(sh, SHELL_NORMAL, "\n");
}

static int cmd_sample_tacq(const struct shell *sh, size_t argc, char **argv)
{
	if (argc > 1) {
		if (protocol_streaming()) {
			shell_error(sh, "stop streaming first");
			return -EBUSY;
		}
		if (sampling_set_tacq((uint8_t)strtoul(argv[1], NULL, 0)) < 0) {
			shell_error(sh, "0..7");
			return -EINVAL;
		}
		if (argc > 2 && sampling_set_tacq_v((uint8_t)strtoul(argv[2], NULL, 0)) < 0) {
			shell_error(sh, "0..7");
			return -EINVAL;
		}
	}

	shell_print(sh, "stream TACQ codes: current %u, voltage %u (apply at next start)",
		    sampling_get_tacq(), sampling_get_tacq_v());
	return 0;
}

static int cmd_sample_selftest(const struct shell *sh, size_t argc, char **argv)
{
	uint32_t seconds = argc > 1 ? strtoul(argv[1], NULL, 0) : 2;
	bool spin = argc > 2 && strcmp(argv[2], "spin") == 0;
	uint32_t period = argc > 3 ? strtoul(argv[3], NULL, 0) : 16000000U / PPK2_SAMPLE_RATE_HZ;
	struct sampling_metrics sm;

	if (protocol_streaming()) {
		shell_error(sh, "stop streaming first");
		return -EBUSY;
	}

	int ret = sampling_selftest(seconds, spin, period, &sm);

	if (ret < 0) {
		shell_error(sh, "failed: %d", ret);
		return ret;
	}

	shell_print(sh, "%u s, no USB traffic, CPU %s, period %u ticks: %u END events, %u ISR entries, "
		    "%u ENDs missed (worst gap %u), worst run %u ticks",
		    seconds, spin ? "spinning" : "idle", period, sm.end_events, sm.isr_entries,
		    sm.isr_missed_ends, sm.isr_max_end_gap, sm.isr_max_run_ticks);
	print_latency(sh, &sm);
	return 0;
}

static int cmd_sample_reset(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(sh);
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	sampling_reset_metrics();
	return 0;
}

static int cmd_dfu(const struct shell *sh, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	shell_print(sh, "rebooting into the bootloader");
	dfu_enter_bootloader();
	return 0;
}

SHELL_STATIC_SUBCMD_SET_CREATE(sub_meta,
	SHELL_CMD(read, NULL, "Print metadata as sent to the host", cmd_meta_read),
	SHELL_CMD_ARG(raw, NULL, "Hex dump EEPROM: raw [offset] [len]", cmd_meta_raw, 1, 2),
	SHELL_CMD_ARG(set, NULL, "Set a field: set <key> <value>", cmd_meta_set, 3, 0),
	SHELL_CMD(save, NULL, "Write metadata to EEPROM", cmd_meta_save),
	SHELL_CMD(defaults, NULL, "Load default (uncalibrated) metadata", cmd_meta_defaults),
	SHELL_CMD_ARG(backup, NULL, "backup write | check | restore", cmd_meta_backup, 2, 0),
	SHELL_SUBCMD_SET_END
);

SHELL_STATIC_SUBCMD_SET_CREATE(sub_power,
	SHELL_CMD_ARG(mode, NULL, "mode ampere|source", cmd_power_mode, 2, 0),
	SHELL_CMD_ARG(vdd, NULL, "vdd <mV>", cmd_power_vdd, 2, 0),
	SHELL_CMD_ARG(out, NULL, "out 0|1", cmd_power_out, 2, 0),
	SHELL_CMD_ARG(ia, NULL, "ia <wiper code>", cmd_power_ia, 2, 0),
	SHELL_CMD_ARG(ia-trim, NULL, "ia-trim [target adc]", cmd_power_ia_trim, 1, 1),
	SHELL_SUBCMD_SET_END
);

SHELL_STATIC_SUBCMD_SET_CREATE(sub_cal,
	SHELL_CMD_ARG(load, NULL, "load 100k|10k|1k|100|off", cmd_cal_load, 2, 0),
	SHELL_CMD_ARG(measure, NULL, "measure [count] [vse|vref|vldo|vbb|vin|vdut|ntc]: averaged raw ADC", cmd_cal_measure, 1, 2),
	SHELL_SUBCMD_SET_END
);

SHELL_STATIC_SUBCMD_SET_CREATE(sub_sample,
	SHELL_CMD_ARG(tacq, NULL, "tacq [I 0-7] [V 0-7]: SAADC acquisition-time codes", cmd_sample_tacq, 1, 2),
	SHELL_CMD_ARG(selftest, NULL, "selftest [seconds] [spin|idle] [period ticks]: sample without USB output", cmd_sample_selftest, 1, 3),
	SHELL_CMD(reset, NULL, "Reset sampling metrics", cmd_sample_reset),
	SHELL_SUBCMD_SET_END
);

SHELL_STATIC_SUBCMD_SET_CREATE(sub_ppk,
	SHELL_CMD(status, NULL, "Show state, voltages and metrics", cmd_status),
	SHELL_CMD(meta, &sub_meta, "Calibration metadata", NULL),
	SHELL_CMD(power, &sub_power, "Supply path", NULL),
	SHELL_CMD(cal, &sub_cal, "Calibration loads and measurement", NULL),
	SHELL_CMD(sample, &sub_sample, "Sampling options", NULL),
	SHELL_CMD(dfu, NULL, "Reboot into the bootloader", cmd_dfu),
	SHELL_SUBCMD_SET_END
);

SHELL_CMD_REGISTER(ppk, &sub_ppk, "Power Profiler Kit II", NULL);
