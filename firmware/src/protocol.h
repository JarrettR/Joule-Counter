/*
 * PPK2 host protocol on the USB data port.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#ifndef PROTOCOL_H_
#define PROTOCOL_H_

#include <stdbool.h>
#include <stdint.h>

struct protocol_stats {
	uint32_t commands;
	uint32_t unknown_bytes;
	/* Blocks that could not be queued, and waits for a free transfer slot
	 * that timed out because the host was not reading.
	 */
	uint32_t tx_failures;
	uint32_t tx_stalls;
	/* Stops whose tail did not reach the host in time. */
	uint32_t flush_timeouts;
	uint32_t bytes_sent;
	uint32_t test_blocks;
};

int protocol_init(void);

bool protocol_streaming(void);
void protocol_get_stats(struct protocol_stats *st);

#endif /* PROTOCOL_H_ */
