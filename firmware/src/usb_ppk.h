/*
 * USB composite device: PPK2 data port, shell port and DFU trigger.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#ifndef USB_PPK_H_
#define USB_PPK_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <zephyr/kernel.h>

/* Both callbacks run in USB stack context; keep them short. */
typedef void (*usb_ppk_rx_cb_t)(const uint8_t *data, size_t len);
typedef void (*usb_ppk_state_cb_t)(bool connected);

void usb_ppk_set_callbacks(usb_ppk_rx_cb_t rx, usb_ppk_state_cb_t state);

int usb_ppk_init(void);

/* The data port is configured and the host has raised DTR. */
bool usb_ppk_data_connected(void);

/*
 * Queues len bytes on the data port's bulk IN endpoint. Blocks for up to
 * timeout while all transfer slots are busy.
 */
int usb_ppk_data_send(const uint8_t *data, size_t len, k_timeout_t timeout);

struct net_buf;

/*
 * Zero-copy variant: reserves a transfer slot and a buffer of size bytes,
 * waiting up to timeout for a slot. Fill buf->data, net_buf_add() what was
 * written, then usb_ppk_data_submit() it, or hand it back unsent with
 * usb_ppk_data_free(). Returns NULL with *err set to -ENOTCONN, -EAGAIN
 * (no slot in time) or -ENOMEM.
 */
struct net_buf *usb_ppk_data_alloc(size_t size, k_timeout_t timeout, int *err);
int usb_ppk_data_submit(struct net_buf *buf);
void usb_ppk_data_free(struct net_buf *buf);

/* Drops every transfer still queued on the data port, sent or not. */
void usb_ppk_data_abort(void);

#endif /* USB_PPK_H_ */
