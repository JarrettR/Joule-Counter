/*
 * USB composite device: PPK2 data port, shell port and DFU trigger.
 *
 * The data port is a CDC ACM function implemented here rather than through
 * Zephyr's UART-shaped CDC ACM class: the stream is about 415 kB/s of 2 KiB
 * blocks, which is best served by packing each block straight into a USB
 * buffer and queueing it whole on the bulk IN endpoint, instead of trickling
 * it through a UART FIFO one 64-byte packet per work item. The shell rides
 * on the stock class.
 *
 * The third function is Nordic's USB DFU trigger interface (vendor class,
 * subclass 1, protocol 1). nrf-device-lib reads the firmware version through
 * it and uses it to bounce the kit into the bootloader when the desktop app
 * wants to reprogram it.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <errno.h>
#include <stdio.h>
#include <string.h>

#include <nrfx.h>

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/usb/usbd.h>
#include <zephyr/usb/usb_ch9.h>
#include <zephyr/usb/class/usb_cdc.h>
#include <zephyr/drivers/usb/udc.h>
#include <zephyr/logging/log.h>

#include "dfu.h"
#include "usb_ppk.h"

LOG_MODULE_REGISTER(usb_ppk, CONFIG_LOG_DEFAULT_LEVEL);

#define BULK_MPS		64U
#define INT_EP_MPS		16U

#define DFU_REQ_DETACH		0x00
#define DFU_REQ_DFU_INFO	0x07
#define DFU_REQ_SEMVER		0x08

static usb_ppk_rx_cb_t rx_cb;
static usb_ppk_state_cb_t state_cb;

/* ---- device ------------------------------------------------------------ */

USBD_DEVICE_DEFINE(ppk_usbd, DEVICE_DT_GET(DT_NODELABEL(zephyr_udc0)),
		   CONFIG_PPK2_USB_VID, CONFIG_PPK2_USB_PID);

USBD_DESC_LANG_DEFINE(ppk_lang);
USBD_DESC_MANUFACTURER_DEFINE(ppk_mfr, CONFIG_PPK2_USB_MANUFACTURER);
USBD_DESC_PRODUCT_DEFINE(ppk_product, CONFIG_PPK2_USB_PRODUCT);
USBD_DESC_CONFIG_DEFINE(ppk_fs_cfg_desc, "PPK2");

/*
 * Stock reports the 48-bit FICR DEVICEADDR as a 12-digit serial ("%04hX%08X"
 * in its string table), not Zephyr's 16-digit DEVICEID. Matching it keeps the
 * kit's identity stable across the two firmwares: Windows COM assignments,
 * nrfutil, and the desktop app's per-device state all key on the serial.
 */
static char ppk_serial_ascii[13];
static struct usbd_desc_node ppk_sn = {
	.str = {
		.utype = USBD_DUT_STRING_SERIAL_NUMBER,
		.ascii7 = true,
	},
	.ptr = ppk_serial_ascii,
	.bDescriptorType = USB_DESC_STRING,
};

/* Bus powered; bMaxPower is in 2 mA units. */
USBD_CONFIGURATION_DEFINE(ppk_fs_config, 0, 250, &ppk_fs_cfg_desc);

/* ---- data port: CDC ACM ------------------------------------------------ */

struct ppk_cdc_desc {
	struct usb_association_descriptor iad;
	struct usb_if_descriptor if0;
	struct cdc_header_descriptor if0_header;
	struct cdc_cm_descriptor if0_cm;
	struct cdc_acm_descriptor if0_acm;
	struct cdc_union_descriptor if0_union;
	struct usb_ep_descriptor if0_int_ep;
	struct usb_if_descriptor if1;
	struct usb_ep_descriptor if1_in_ep;
	struct usb_ep_descriptor if1_out_ep;
	struct usb_desc_header nil_desc;
};

static struct ppk_cdc_desc cdc_desc = {
	.iad = {
		.bLength = sizeof(struct usb_association_descriptor),
		.bDescriptorType = USB_DESC_INTERFACE_ASSOC,
		.bFirstInterface = 0,
		.bInterfaceCount = 2,
		.bFunctionClass = USB_BCC_CDC_CONTROL,
		.bFunctionSubClass = ACM_SUBCLASS,
		.bFunctionProtocol = 0,
		.iFunction = 0,
	},
	.if0 = {
		.bLength = sizeof(struct usb_if_descriptor),
		.bDescriptorType = USB_DESC_INTERFACE,
		.bInterfaceNumber = 0,
		.bAlternateSetting = 0,
		.bNumEndpoints = 1,
		.bInterfaceClass = USB_BCC_CDC_CONTROL,
		.bInterfaceSubClass = ACM_SUBCLASS,
		.bInterfaceProtocol = 0,
		.iInterface = 0,
	},
	.if0_header = {
		.bFunctionLength = sizeof(struct cdc_header_descriptor),
		.bDescriptorType = USB_DESC_CS_INTERFACE,
		.bDescriptorSubtype = HEADER_FUNC_DESC,
		.bcdCDC = sys_cpu_to_le16(USB_SRN_1_1),
	},
	.if0_cm = {
		.bFunctionLength = sizeof(struct cdc_cm_descriptor),
		.bDescriptorType = USB_DESC_CS_INTERFACE,
		.bDescriptorSubtype = CALL_MANAGEMENT_FUNC_DESC,
		.bmCapabilities = 0,
		.bDataInterface = 1,
	},
	.if0_acm = {
		.bFunctionLength = sizeof(struct cdc_acm_descriptor),
		.bDescriptorType = USB_DESC_CS_INTERFACE,
		.bDescriptorSubtype = ACM_FUNC_DESC,
		.bmCapabilities = BIT(1),
	},
	.if0_union = {
		.bFunctionLength = sizeof(struct cdc_union_descriptor),
		.bDescriptorType = USB_DESC_CS_INTERFACE,
		.bDescriptorSubtype = UNION_FUNC_DESC,
		.bControlInterface = 0,
		.bSubordinateInterface0 = 1,
	},
	.if0_int_ep = {
		.bLength = sizeof(struct usb_ep_descriptor),
		.bDescriptorType = USB_DESC_ENDPOINT,
		.bEndpointAddress = 0x81,
		.bmAttributes = USB_EP_TYPE_INTERRUPT,
		.wMaxPacketSize = sys_cpu_to_le16(INT_EP_MPS),
		.bInterval = USB_FS_INT_EP_INTERVAL(10000U),
	},
	.if1 = {
		.bLength = sizeof(struct usb_if_descriptor),
		.bDescriptorType = USB_DESC_INTERFACE,
		.bInterfaceNumber = 1,
		.bAlternateSetting = 0,
		.bNumEndpoints = 2,
		.bInterfaceClass = USB_BCC_CDC_DATA,
		.bInterfaceSubClass = 0,
		.bInterfaceProtocol = 0,
		.iInterface = 0,
	},
	.if1_in_ep = {
		.bLength = sizeof(struct usb_ep_descriptor),
		.bDescriptorType = USB_DESC_ENDPOINT,
		.bEndpointAddress = 0x82,
		.bmAttributes = USB_EP_TYPE_BULK,
		.wMaxPacketSize = sys_cpu_to_le16(BULK_MPS),
		.bInterval = 0,
	},
	.if1_out_ep = {
		.bLength = sizeof(struct usb_ep_descriptor),
		.bDescriptorType = USB_DESC_ENDPOINT,
		.bEndpointAddress = 0x01,
		.bmAttributes = USB_EP_TYPE_BULK,
		.wMaxPacketSize = sys_cpu_to_le16(BULK_MPS),
		.bInterval = 0,
	},
	.nil_desc = {
		.bLength = 0,
		.bDescriptorType = 0,
	},
};

static const struct usb_desc_header *cdc_fs_desc[] = {
	(struct usb_desc_header *)&cdc_desc.iad,
	(struct usb_desc_header *)&cdc_desc.if0,
	(struct usb_desc_header *)&cdc_desc.if0_header,
	(struct usb_desc_header *)&cdc_desc.if0_cm,
	(struct usb_desc_header *)&cdc_desc.if0_acm,
	(struct usb_desc_header *)&cdc_desc.if0_union,
	(struct usb_desc_header *)&cdc_desc.if0_int_ep,
	(struct usb_desc_header *)&cdc_desc.if1,
	(struct usb_desc_header *)&cdc_desc.if1_in_ep,
	(struct usb_desc_header *)&cdc_desc.if1_out_ep,
	(struct usb_desc_header *)&cdc_desc.nil_desc,
};

#define CDC_ENABLED	0
#define CDC_OUT_BUSY	1

struct ppk_cdc_data {
	struct ppk_cdc_desc *desc;
	const struct usb_desc_header **fs_desc;
	struct cdc_acm_line_coding line_coding;
	uint16_t line_state;
	atomic_t state;
};

static struct ppk_cdc_data cdc_data = {
	.desc = &cdc_desc,
	.fs_desc = cdc_fs_desc,
	.line_coding = { sys_cpu_to_le32(115200), 0, 0, 8 },
};

static K_SEM_DEFINE(tx_slots, CONFIG_PPK2_USB_TX_INFLIGHT, CONFIG_PPK2_USB_TX_INFLIGHT);

static void notify_state(void)
{
	if (state_cb != NULL) {
		state_cb(usb_ppk_data_connected());
	}
}

static int cdc_submit_out(struct usbd_class_data *const c_data)
{
	struct ppk_cdc_data *data = usbd_class_get_private(c_data);
	struct net_buf *buf;
	int ret;

	if (!atomic_test_bit(&data->state, CDC_ENABLED)) {
		return -EPERM;
	}
	if (atomic_test_and_set_bit(&data->state, CDC_OUT_BUSY)) {
		return -EBUSY;
	}

	buf = usbd_ep_buf_alloc(c_data, data->desc->if1_out_ep.bEndpointAddress, BULK_MPS);
	if (buf == NULL) {
		atomic_clear_bit(&data->state, CDC_OUT_BUSY);
		return -ENOMEM;
	}

	ret = usbd_ep_enqueue(c_data, buf);
	if (ret != 0) {
		net_buf_unref(buf);
		atomic_clear_bit(&data->state, CDC_OUT_BUSY);
	}

	return ret;
}

static int cdc_request(struct usbd_class_data *const c_data, struct net_buf *buf, int err)
{
	struct ppk_cdc_data *data = usbd_class_get_private(c_data);
	struct udc_buf_info *bi = (struct udc_buf_info *)net_buf_user_data(buf);
	uint8_t ep = bi->ep;
	size_t len = buf->len;

	if (ep == data->desc->if1_out_ep.bEndpointAddress) {
		if (err == 0 && len > 0 && rx_cb != NULL) {
			rx_cb(buf->data, len);
		}
		net_buf_unref(buf);
		atomic_clear_bit(&data->state, CDC_OUT_BUSY);
		if (err != -ECONNABORTED) {
			cdc_submit_out(c_data);
		}
		return 0;
	}

	if (ep == data->desc->if1_in_ep.bEndpointAddress) {
		/* One completion per usb_ppk_data_send(): the controller pulls
		 * bytes from the buffer as it sends them, so len is 0 here and
		 * says nothing about what the transfer carried.
		 */
		net_buf_unref(buf);
		k_sem_give(&tx_slots);
		return 0;
	}

	net_buf_unref(buf);
	return 0;
}

static void cdc_update(struct usbd_class_data *const c_data, uint8_t iface, uint8_t alternate)
{
	ARG_UNUSED(c_data);
	ARG_UNUSED(iface);
	ARG_UNUSED(alternate);
}

static int cdc_control_to_host(struct usbd_class_data *const c_data,
			       const struct usb_setup_packet *const setup,
			       struct net_buf *const buf)
{
	struct ppk_cdc_data *data = usbd_class_get_private(c_data);

	if (setup->bRequest == GET_LINE_CODING) {
		net_buf_add_mem(buf, &data->line_coding,
				MIN(sizeof(data->line_coding), setup->wLength));
		return 0;
	}

	errno = -ENOTSUP;
	return 0;
}

static int cdc_control_to_dev(struct usbd_class_data *const c_data,
			      const struct usb_setup_packet *const setup,
			      const struct net_buf *const buf)
{
	struct ppk_cdc_data *data = usbd_class_get_private(c_data);

	switch (setup->bRequest) {
	case SET_LINE_CODING:
		if (setup->wLength == sizeof(data->line_coding)) {
			memcpy(&data->line_coding, buf->data, sizeof(data->line_coding));
		}
		return 0;
	case SET_CONTROL_LINE_STATE:
		data->line_state = setup->wValue;
		notify_state();
		return 0;
	default:
		errno = -ENOTSUP;
		return 0;
	}
}

static void *cdc_get_desc(struct usbd_class_data *const c_data, const enum usbd_speed speed)
{
	struct ppk_cdc_data *data = usbd_class_get_private(c_data);

	ARG_UNUSED(speed);
	return data->fs_desc;
}

static void cdc_enable(struct usbd_class_data *const c_data)
{
	struct ppk_cdc_data *data = usbd_class_get_private(c_data);

	atomic_set_bit(&data->state, CDC_ENABLED);
	atomic_clear_bit(&data->state, CDC_OUT_BUSY);
	k_sem_reset(&tx_slots);
	for (int k = 0; k < CONFIG_PPK2_USB_TX_INFLIGHT; k++) {
		k_sem_give(&tx_slots);
	}
	cdc_submit_out(c_data);
	notify_state();
}

static void cdc_disable(struct usbd_class_data *const c_data)
{
	struct ppk_cdc_data *data = usbd_class_get_private(c_data);

	atomic_clear_bit(&data->state, CDC_ENABLED);
	data->line_state = 0;
	notify_state();
}

static int cdc_init(struct usbd_class_data *const c_data)
{
	struct ppk_cdc_data *data = usbd_class_get_private(c_data);
	struct ppk_cdc_desc *desc = data->desc;

	/* The stack has assigned interface numbers by now; point the
	 * functional descriptors at them.
	 */
	desc->iad.bFirstInterface = desc->if0.bInterfaceNumber;
	desc->if0_union.bControlInterface = desc->if0.bInterfaceNumber;
	desc->if0_union.bSubordinateInterface0 = desc->if1.bInterfaceNumber;
	desc->if0_cm.bDataInterface = desc->if1.bInterfaceNumber;

	return 0;
}

static const struct usbd_class_api cdc_api = {
	.update = cdc_update,
	.control_to_host = cdc_control_to_host,
	.control_to_dev = cdc_control_to_dev,
	.request = cdc_request,
	.get_desc = cdc_get_desc,
	.enable = cdc_enable,
	.disable = cdc_disable,
	.init = cdc_init,
};

USBD_DEFINE_CLASS(ppk_data, &cdc_api, &cdc_data, NULL);

/* ---- DFU trigger ------------------------------------------------------- */

struct ppk_dfu_desc {
	struct usb_if_descriptor if0;
	struct usb_desc_header nil_desc;
};

static struct ppk_dfu_desc dfu_desc = {
	.if0 = {
		.bLength = sizeof(struct usb_if_descriptor),
		.bDescriptorType = USB_DESC_INTERFACE,
		.bInterfaceNumber = 0,
		.bAlternateSetting = 0,
		.bNumEndpoints = 0,
		.bInterfaceClass = USB_BCC_VENDOR,
		.bInterfaceSubClass = 0x01,
		.bInterfaceProtocol = 0x01,
		.iInterface = 0,
	},
	.nil_desc = {
		.bLength = 0,
		.bDescriptorType = 0,
	},
};

static const struct usb_desc_header *dfu_fs_desc[] = {
	(struct usb_desc_header *)&dfu_desc.if0,
	(struct usb_desc_header *)&dfu_desc.nil_desc,
};

struct ppk_dfu_data {
	const struct usb_desc_header **fs_desc;
};

static struct ppk_dfu_data dfu_data = {
	.fs_desc = dfu_fs_desc,
};

static const struct usbd_cctx_vendor_req dfu_vreqs =
	USBD_VENDOR_REQ(DFU_REQ_DETACH, DFU_REQ_DFU_INFO, DFU_REQ_SEMVER);

static const char dfu_semver[] = CONFIG_PPK2_DFU_SEMVER;

static int dfu_control_to_host(struct usbd_class_data *const c_data,
			       const struct usb_setup_packet *const setup,
			       struct net_buf *const buf)
{
	ARG_UNUSED(c_data);

	switch (setup->bRequest) {
	case DFU_REQ_DFU_INFO: {
		struct dfu_info info;

		dfu_get_info(&info);
		net_buf_add_mem(buf, &info, MIN(sizeof(info), setup->wLength));
		return 0;
	}
	case DFU_REQ_SEMVER:
		net_buf_add_mem(buf, dfu_semver, MIN(strlen(dfu_semver), setup->wLength));
		return 0;
	default:
		errno = -ENOTSUP;
		return 0;
	}
}

static int dfu_control_to_dev(struct usbd_class_data *const c_data,
			      const struct usb_setup_packet *const setup,
			      const struct net_buf *const buf)
{
	ARG_UNUSED(c_data);
	ARG_UNUSED(buf);

	if (setup->bRequest == DFU_REQ_DETACH) {
		dfu_enter_bootloader();
		return 0;
	}

	errno = -ENOTSUP;
	return 0;
}

static int dfu_request(struct usbd_class_data *const c_data, struct net_buf *buf, int err)
{
	ARG_UNUSED(c_data);
	ARG_UNUSED(err);
	net_buf_unref(buf);
	return 0;
}

static void dfu_update(struct usbd_class_data *const c_data, uint8_t iface, uint8_t alternate)
{
	ARG_UNUSED(c_data);
	ARG_UNUSED(iface);
	ARG_UNUSED(alternate);
}

static void *dfu_get_desc(struct usbd_class_data *const c_data, const enum usbd_speed speed)
{
	struct ppk_dfu_data *data = usbd_class_get_private(c_data);

	ARG_UNUSED(speed);
	return data->fs_desc;
}

static void dfu_enable(struct usbd_class_data *const c_data)
{
	ARG_UNUSED(c_data);
}

static void dfu_disable(struct usbd_class_data *const c_data)
{
	ARG_UNUSED(c_data);
}

static int dfu_init(struct usbd_class_data *const c_data)
{
	ARG_UNUSED(c_data);
	return 0;
}

static const struct usbd_class_api dfu_api = {
	.update = dfu_update,
	.control_to_host = dfu_control_to_host,
	.control_to_dev = dfu_control_to_dev,
	.request = dfu_request,
	.get_desc = dfu_get_desc,
	.enable = dfu_enable,
	.disable = dfu_disable,
	.init = dfu_init,
};

USBD_DEFINE_CLASS(ppk_dfu, &dfu_api, &dfu_data, &dfu_vreqs);

/* ---- public ------------------------------------------------------------ */

void usb_ppk_set_callbacks(usb_ppk_rx_cb_t rx, usb_ppk_state_cb_t state)
{
	rx_cb = rx;
	state_cb = state;
}

bool usb_ppk_data_connected(void)
{
	return atomic_test_bit(&cdc_data.state, CDC_ENABLED) &&
	       (cdc_data.line_state & SET_CONTROL_LINE_STATE_DTR) != 0;
}

struct net_buf *usb_ppk_data_alloc(size_t size, k_timeout_t timeout, int *err)
{
	uint8_t ep = cdc_desc.if1_in_ep.bEndpointAddress;
	struct net_buf *buf;

	if (!atomic_test_bit(&cdc_data.state, CDC_ENABLED)) {
		*err = -ENOTCONN;
		return NULL;
	}

	if (k_sem_take(&tx_slots, timeout) != 0) {
		*err = -EAGAIN;
		return NULL;
	}

	buf = usbd_ep_buf_alloc(&ppk_data, ep, size);
	if (buf == NULL) {
		k_sem_give(&tx_slots);
		*err = -ENOMEM;
		return NULL;
	}

	*err = 0;
	return buf;
}

void usb_ppk_data_free(struct net_buf *buf)
{
	net_buf_unref(buf);
	k_sem_give(&tx_slots);
}

int usb_ppk_data_submit(struct net_buf *buf)
{
	int ret;

	/* A transfer that ends on a packet boundary needs a zero-length packet
	 * behind it, or the host keeps waiting for more. The controller appends
	 * it when asked, keeping this one buffer and one completion per block.
	 */
	udc_get_buf_info(buf)->zlp = ((buf->len % BULK_MPS) == 0);

	ret = usbd_ep_enqueue(&ppk_data, buf);
	if (ret != 0) {
		usb_ppk_data_free(buf);
	}

	return ret;
}

void usb_ppk_data_abort(void)
{
	/* Only when something is queued: dequeueing an idle, enabled
	 * endpoint does nothing but log about it.
	 */
	if (atomic_test_bit(&cdc_data.state, CDC_ENABLED) &&
	    k_sem_count_get(&tx_slots) < CONFIG_PPK2_USB_TX_INFLIGHT) {
		/* Each dequeued buffer completes with -ECONNABORTED through
		 * cdc_request(), which returns its transfer slot.
		 */
		(void)usbd_ep_dequeue(&ppk_usbd, cdc_desc.if1_in_ep.bEndpointAddress);
	}
}

int usb_ppk_data_send(const uint8_t *data, size_t len, k_timeout_t timeout)
{
	int err;
	struct net_buf *buf = usb_ppk_data_alloc(len, timeout, &err);

	if (buf == NULL) {
		return err;
	}

	net_buf_add_mem(buf, data, len);
	return usb_ppk_data_submit(buf);
}

int usb_ppk_init(void)
{
	int err;

	/* Top two bits forced high, as for a BLE random static address: a real
	 * unit whose DEVICEADDR reads 26A6... enumerates as E6A6... under stock.
	 */
	snprintf(ppk_serial_ascii, sizeof(ppk_serial_ascii), "%04X%08X",
		 (unsigned int)((NRF_FICR->DEVICEADDR[1] & 0xFFFFU) | 0xC000U),
		 (unsigned int)NRF_FICR->DEVICEADDR[0]);
	/* Two header bytes plus UTF-16LE payload; no terminator. */
	ppk_sn.bLength = 2 + 2 * strlen(ppk_serial_ascii);

	err = usbd_add_descriptor(&ppk_usbd, &ppk_lang);
	if (err == 0) {
		err = usbd_add_descriptor(&ppk_usbd, &ppk_mfr);
	}
	if (err == 0) {
		err = usbd_add_descriptor(&ppk_usbd, &ppk_product);
	}
	if (err == 0) {
		err = usbd_add_descriptor(&ppk_usbd, &ppk_sn);
	}
	if (err != 0) {
		LOG_ERR("string descriptors: %d", err);
		return err;
	}

	err = usbd_add_configuration(&ppk_usbd, USBD_SPEED_FS, &ppk_fs_config);
	if (err != 0) {
		LOG_ERR("configuration: %d", err);
		return err;
	}

	/* Registration order is interface order, and it has to match the stock
	 * firmware's layout: Nordic's Windows driver package binds the DFU
	 * trigger driver by hardware ID VID_1915&PID_C00A&MI_00, i.e. it expects
	 * the trigger on interface 0. Put a CDC function there instead and
	 * Windows hands that COM port to WinUSB while the real trigger is left
	 * without a driver. The data port still ends up as the first serial
	 * port (MI_01), which is what the desktop app opens.
	 */
	err = usbd_register_class(&ppk_usbd, "ppk_dfu", USBD_SPEED_FS, 1);
	if (err == 0) {
		err = usbd_register_class(&ppk_usbd, "ppk_data", USBD_SPEED_FS, 1);
	}
	if (err == 0) {
		err = usbd_register_class(&ppk_usbd, "cdc_acm_0", USBD_SPEED_FS, 1);
	}
	if (err != 0) {
		LOG_ERR("class registration: %d", err);
		return err;
	}

	usbd_device_set_code_triple(&ppk_usbd, USBD_SPEED_FS, USB_BCC_MISCELLANEOUS, 0x02, 0x01);
	usbd_device_set_bcd_device(&ppk_usbd,
				   (CONFIG_PPK2_FW_VERSION_MAJOR << 8) | CONFIG_PPK2_FW_VERSION_MINOR);

	err = usbd_init(&ppk_usbd);
	if (err != 0) {
		LOG_ERR("usbd_init: %d", err);
		return err;
	}

	err = usbd_enable(&ppk_usbd);
	if (err != 0) {
		LOG_ERR("usbd_enable: %d", err);
		return err;
	}

	return 0;
}
