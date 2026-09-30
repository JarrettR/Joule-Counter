/*
 * Calibration metadata stored in the on-board EEPROM (U7).
 *
 * The EEPROM is the one copy of this unit's factory calibration, so writes
 * are field-wise, to offsets confirmed against the stock layout, and only
 * for values this firmware actually changes. Everything else in the stock
 * image is read and left alone.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <ctype.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/eeprom.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/sys/crc.h>
#include <zephyr/logging/log.h>

#include <nrfx.h>

#include "metadata.h"
#include "ppk2.h"
#include "sampling.h"

LOG_MODULE_REGISTER(metadata, CONFIG_LOG_DEFAULT_LEVEL);

/*
 * Our own backup lives clear of both stock regions: its primary image ends at
 * 0x100 and its backup copy (with a trailing CRC) occupies 0x600..0x702.
 */
#define BACKUP_OFFSET		0x200
#define BACKUP_MAGIC		0x324B5050	/* "PPK2" */
#define SAVE_DEBOUNCE		K_SECONDS(2)

#define IA_DEFAULT		128
#define IA_MAX			256

/*
 * Stock masks the range-0 gain terms when it reports them, whatever the
 * EEPROM holds (a real unit stored GS0 = -1138.7, GI0 = 1.03 and reported
 * 1e-19 and 1.0). The epsilon rather than zero matters: the desktop app
 * substitutes its own default of 1.0 for any value that parses as zero.
 */
#define REPORTED_GS0		1e-19f
#define REPORTED_GI0		1.0f

struct backup_image {
	uint32_t magic;
	struct ppk2_metadata meta;
	uint32_t crc;
} __packed;

static const struct device *const eeprom = DEVICE_DT_GET(DT_ALIAS(eeprom_0));

static struct ppk2_metadata meta;
/* What the EEPROM holds for the fields we own, so saves touch only changes. */
static struct ppk2_metadata stored;
static bool calibrated;
static bool ia_unknown;
static K_MUTEX_DEFINE(lock);

/*
 * Mirrors the desktop app's own fallbacks, which it substitutes for any key
 * that parses as zero. Sending anything else for an uncalibrated kit would
 * therefore be overridden anyway.
 */
static const struct ppk2_metadata defaults = {
	.r = { 1031.64f, 101.65f, 10.15f, 0.94f, 0.043f },
	.gs = { 1.0f, 1.0f, 1.0f, 1.0f, 1.0f },
	.gi = { 1.0f, 1.0f, 1.0f, 1.0f, 1.0f },
	.ug = { 1.0f, 1.0f, 1.0f, 1.0f, 1.0f },
	.vdd = CONFIG_PPK2_DEFAULT_VDD_MV,
	.mode = PPK2_MODE_AMPERE,
	.calibrated = 0,
	.ia = IA_DEFAULT,
};

static uint16_t derived_hw(void)
{
	/* Stock reports the low 16 bits of DEVICEID[0] as a decimal integer;
	 * a real unit confirmed the field and its width.
	 */
	return (uint16_t)(NRF_FICR->DEVICEID[0] & 0xFFFFU);
}

static bool all_finite(const float *v, size_t n)
{
	for (size_t k = 0; k < n; k++) {
		if (!isfinite(v[k])) {
			return false;
		}
	}

	return true;
}

static bool resistances_plausible(const float *r)
{
	for (size_t k = 0; k < PPK2_RANGE_COUNT; k++) {
		if (!isfinite(r[k]) || r[k] <= 0.001f || r[k] > 100000.0f) {
			return false;
		}
	}

	return true;
}

static void decode_image(const uint8_t *img, struct ppk2_metadata *m)
{
	memcpy(m->r, &img[EEPROM_OFF_R], sizeof(m->r));
	memcpy(m->gs, &img[EEPROM_OFF_GS], sizeof(m->gs));
	memcpy(m->o, &img[EEPROM_OFF_O], sizeof(m->o));
	memcpy(m->s, &img[EEPROM_OFF_S], sizeof(m->s));
	memcpy(m->i, &img[EEPROM_OFF_I], sizeof(m->i));
	memcpy(m->gi, &img[EEPROM_OFF_GI], sizeof(m->gi));
	memcpy(m->ug, &img[EEPROM_OFF_UG], sizeof(m->ug));
	m->vdd = sys_get_le16(&img[EEPROM_OFF_VDD]);
	m->mode = img[EEPROM_OFF_MODE];
	m->calibrated = img[EEPROM_OFF_CALIBRATED];
	m->ia = sys_get_le16(&img[EEPROM_OFF_IA]);
	m->hw = derived_hw();
}

static void sanitize(struct ppk2_metadata *m)
{
	if (!all_finite(m->gs, PPK2_RANGE_COUNT)) {
		memcpy(m->gs, defaults.gs, sizeof(m->gs));
	}
	if (!all_finite(m->gi, PPK2_RANGE_COUNT)) {
		memcpy(m->gi, defaults.gi, sizeof(m->gi));
	}
	if (!all_finite(m->o, PPK2_RANGE_COUNT)) {
		memset(m->o, 0, sizeof(m->o));
	}
	if (!all_finite(m->s, PPK2_RANGE_COUNT)) {
		memset(m->s, 0, sizeof(m->s));
	}
	if (!all_finite(m->i, PPK2_RANGE_COUNT)) {
		memset(m->i, 0, sizeof(m->i));
	}
	if (!all_finite(m->ug, PPK2_RANGE_COUNT)) {
		memcpy(m->ug, defaults.ug, sizeof(m->ug));
	}
	for (size_t k = 0; k < PPK2_RANGE_COUNT; k++) {
		if (m->ug[k] <= 0.0f || m->ug[k] > 10.0f) {
			m->ug[k] = 1.0f;
		}
	}

	if (m->vdd < 800 || m->vdd > 5000) {
		m->vdd = CONFIG_PPK2_DEFAULT_VDD_MV;
	}
	if (m->mode != PPK2_MODE_AMPERE && m->mode != PPK2_MODE_SOURCE) {
		m->mode = PPK2_MODE_AMPERE;
	}
	if (m->calibrated > 1) {
		m->calibrated = 0;
	}

	/* Fresh EEPROM reads 0xFFFF here, and the one real unit seen so far
	 * held a value far beyond the wiper's range in its stock backup.
	 */
	ia_unknown = m->ia > IA_MAX;
	if (ia_unknown) {
		LOG_WRN("no usable IA wiper value in EEPROM (%u), will trim", m->ia);
		m->ia = IA_DEFAULT;
	}
}

void metadata_load_defaults(void)
{
	k_mutex_lock(&lock, K_FOREVER);
	meta = defaults;
	meta.hw = derived_hw();
	calibrated = false;
	ia_unknown = true;
	k_mutex_unlock(&lock);
}

int metadata_init(void)
{
	uint8_t img[EEPROM_STOCK_IMAGE_SIZE];
	int ret;

	if (!device_is_ready(eeprom)) {
		LOG_ERR("EEPROM not ready");
		metadata_load_defaults();
		return -ENODEV;
	}

	ret = eeprom_read(eeprom, 0, img, sizeof(img));
	if (ret < 0) {
		LOG_ERR("EEPROM read failed: %d", ret);
		metadata_load_defaults();
		return ret;
	}

	k_mutex_lock(&lock, K_FOREVER);
	decode_image(img, &meta);
	stored = meta;

	if (resistances_plausible(meta.r)) {
		calibrated = true;
		sanitize(&meta);
		LOG_INF("calibration loaded: R0=%.2f R4=%.4f vdd=%u mode=%u ia=%u flag=%u",
			(double)meta.r[0], (double)meta.r[4], meta.vdd, meta.mode, meta.ia,
			meta.calibrated);
	} else {
		LOG_WRN("EEPROM holds no usable calibration, using defaults");
		meta = defaults;
		meta.hw = derived_hw();
		calibrated = false;
		ia_unknown = true;
	}
	k_mutex_unlock(&lock);

	return 0;
}

struct ppk2_metadata *metadata_get(void)
{
	return &meta;
}

bool metadata_is_calibrated(void)
{
	return calibrated;
}

bool metadata_ia_unknown(void)
{
	return ia_unknown;
}

static int write_if_changed(size_t offset, const void *now, void *was, size_t len)
{
	if (memcmp(now, was, len) == 0) {
		return 0;
	}

	int ret = eeprom_write(eeprom, offset, now, len);

	if (ret == 0) {
		memcpy(was, now, len);
	} else {
		LOG_ERR("EEPROM write at %u failed: %d", (unsigned int)offset, ret);
	}

	return ret;
}

int metadata_save(void)
{
	struct ppk2_metadata m;
	uint8_t le16[2];
	int ret;

	if (!device_is_ready(eeprom)) {
		return -ENODEV;
	}

	k_mutex_lock(&lock, K_FOREVER);
	m = meta;

	sys_put_le16(m.vdd, le16);
	ret = write_if_changed(EEPROM_OFF_VDD, le16, &stored.vdd, sizeof(le16));
	stored.vdd = m.vdd;

	if (ret == 0) {
		ret = write_if_changed(EEPROM_OFF_UG, m.ug, stored.ug, sizeof(m.ug));
	}
	if (ret == 0) {
		ret = write_if_changed(EEPROM_OFF_MODE, &m.mode, &stored.mode, sizeof(m.mode));
	}
	if (ret == 0) {
		sys_put_le16(m.ia, le16);
		ret = write_if_changed(EEPROM_OFF_IA, le16, &stored.ia, sizeof(le16));
		stored.ia = m.ia;
	}
	k_mutex_unlock(&lock);

	return ret;
}

static void save_work_handler(struct k_work *work)
{
	ARG_UNUSED(work);
	metadata_save();
}

static K_WORK_DELAYABLE_DEFINE(save_work, save_work_handler);

void metadata_save_deferred(void)
{
	k_work_reschedule(&save_work, SAVE_DEBOUNCE);
}

int metadata_backup_write(void)
{
	struct backup_image img;

	if (!device_is_ready(eeprom)) {
		return -ENODEV;
	}

	k_mutex_lock(&lock, K_FOREVER);
	img.magic = BACKUP_MAGIC;
	img.meta = meta;
	k_mutex_unlock(&lock);
	img.crc = crc32_ieee((const uint8_t *)&img.meta, sizeof(img.meta));

	return eeprom_write(eeprom, BACKUP_OFFSET, &img, sizeof(img));
}

static int backup_read(struct backup_image *img)
{
	int ret;

	if (!device_is_ready(eeprom)) {
		return -ENODEV;
	}

	ret = eeprom_read(eeprom, BACKUP_OFFSET, img, sizeof(*img));
	if (ret < 0) {
		return ret;
	}

	if (img->magic != BACKUP_MAGIC ||
	    img->crc != crc32_ieee((const uint8_t *)&img->meta, sizeof(img->meta))) {
		return -EBADMSG;
	}

	return 0;
}

int metadata_backup_valid(void)
{
	struct backup_image img;

	return backup_read(&img);
}

/*
 * Restores only what this firmware owns. The factory constants are not
 * rewritten from our backup: if they were lost, stock's own backup copy at
 * 0x600 is the authoritative source, not ours.
 */
int metadata_backup_restore(void)
{
	struct backup_image img;
	int ret = backup_read(&img);

	if (ret < 0) {
		return ret;
	}

	k_mutex_lock(&lock, K_FOREVER);
	memcpy(meta.ug, img.meta.ug, sizeof(meta.ug));
	meta.vdd = img.meta.vdd;
	meta.mode = img.meta.mode;
	meta.ia = img.meta.ia;
	k_mutex_unlock(&lock);

	return metadata_save();
}

/*
 * The desktop app lower-cases this text, turns every "key: value" line into a
 * JSON member and parses the result, so the values must be plain numbers:
 * never NaN or infinity.
 */
size_t metadata_format(char *buf, size_t size)
{
	struct ppk2_metadata m;
	size_t pos = 0;

	k_mutex_lock(&lock, K_FOREVER);
	m = meta;
	k_mutex_unlock(&lock);

	m.gs[0] = REPORTED_GS0;
	m.gi[0] = REPORTED_GI0;

#define PUT(...)								\
	do {									\
		int n_ = snprintf(buf + pos, size - pos, __VA_ARGS__);		\
		if (n_ < 0 || (size_t)n_ >= size - pos) {			\
			return 0;						\
		}								\
		pos += (size_t)n_;						\
	} while (0)

	PUT("Calibrated: %u\n", m.calibrated);
	for (int k = 0; k < PPK2_RANGE_COUNT; k++) {
		PUT("R%d: %.20f\n", k, (double)m.r[k]);
	}
	for (int k = 0; k < PPK2_RANGE_COUNT; k++) {
		PUT("GS%d: %.20f\n", k, (double)m.gs[k]);
	}
	for (int k = 0; k < PPK2_RANGE_COUNT; k++) {
		PUT("GI%d: %.20f\n", k, (double)m.gi[k]);
	}
	for (int k = 0; k < PPK2_RANGE_COUNT; k++) {
		PUT("O%d: %.20f\n", k, (double)m.o[k]);
	}
	PUT("VDD: %u\n", m.vdd);
	PUT("HW: %u\n", m.hw);
	PUT("mode: %u\n", m.mode);
	for (int k = 0; k < PPK2_RANGE_COUNT; k++) {
		PUT("S%d: %.20f\n", k, (double)m.s[k]);
	}
	for (int k = 0; k < PPK2_RANGE_COUNT; k++) {
		PUT("I%d: %.20f\n", k, (double)m.i[k]);
	}
	for (int k = 0; k < PPK2_RANGE_COUNT; k++) {
		PUT("UG%d: %.20f\n", k, (double)m.ug[k]);
	}
	PUT("IA: %u\n", m.ia);

	/* Joule Counter additions: how to scale the stream's voltage field,
	 * the sample rate and the block format, so the host carries no copy
	 * of any of them.
	 */
	float vfs, vdiv;

	sampling_voltage_scale(&vfs, &vdiv);
	PUT("VFS: %.1f\n", (double)vfs);
	PUT("VDIV: %.3f\n", (double)vdiv);
	PUT("SampleRate: %u\n", PPK2_SAMPLE_RATE_HZ);
	PUT("BlockFormat: %u\n", PPK2_BLOCK_VERSION);
	PUT("END\n");
#undef PUT

	return pos;
}

static float *float_array(struct ppk2_metadata *m, const char *name)
{
	if (strcmp(name, "r") == 0) {
		return m->r;
	}
	if (strcmp(name, "gs") == 0) {
		return m->gs;
	}
	if (strcmp(name, "gi") == 0) {
		return m->gi;
	}
	if (strcmp(name, "o") == 0) {
		return m->o;
	}
	if (strcmp(name, "s") == 0) {
		return m->s;
	}
	if (strcmp(name, "i") == 0) {
		return m->i;
	}
	if (strcmp(name, "ug") == 0) {
		return m->ug;
	}

	return NULL;
}

/*
 * Edits the in-RAM copy only. Factory constants (r, gs, gi, o, s, i) can be
 * edited here for experiments but are never persisted by metadata_save().
 */
int metadata_set(const char *key, const char *value)
{
	char name[8];
	size_t n = 0;
	int ret = 0;

	while (key[n] != '\0' && !isdigit((unsigned char)key[n]) && n < sizeof(name) - 1) {
		name[n] = (char)tolower((unsigned char)key[n]);
		n++;
	}
	name[n] = '\0';

	k_mutex_lock(&lock, K_FOREVER);

	if (key[n] != '\0') {
		float *arr = float_array(&meta, name);
		int idx = atoi(&key[n]);

		if (arr == NULL || idx < 0 || idx >= PPK2_RANGE_COUNT) {
			ret = -EINVAL;
		} else {
			float v = strtof(value, NULL);

			if (!isfinite(v)) {
				ret = -EINVAL;
			} else {
				arr[idx] = v;
				if (arr == meta.r) {
					calibrated = resistances_plausible(meta.r);
				}
			}
		}
	} else if (strcmp(name, "vdd") == 0) {
		meta.vdd = (uint16_t)strtoul(value, NULL, 0);
	} else if (strcmp(name, "mode") == 0) {
		meta.mode = (uint8_t)strtoul(value, NULL, 0);
	} else if (strcmp(name, "ia") == 0) {
		meta.ia = (uint16_t)strtoul(value, NULL, 0);
		ia_unknown = false;
	} else {
		ret = -EINVAL;
	}

	k_mutex_unlock(&lock);

	return ret;
}

int metadata_raw_read(size_t offset, uint8_t *buf, size_t len)
{
	if (!device_is_ready(eeprom)) {
		return -ENODEV;
	}

	return eeprom_read(eeprom, offset, buf, len);
}
