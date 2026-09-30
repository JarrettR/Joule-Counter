# SPDX-License-Identifier: Apache-2.0

cmake_minimum_required(VERSION 3.20.0)

# The ppk2 board definition lives in this tree, not in Zephyr's.
list(APPEND BOARD_ROOT ${CMAKE_CURRENT_SOURCE_DIR})

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(ppk2_firmware)

target_sources(app PRIVATE
	src/main.c
	src/board_io.c
	src/digipot.c
	src/metadata.c
	src/sampling.c
	src/power.c
	src/usb_ppk.c
	src/dfu.c
	src/protocol.c
	src/leds.c
	src/shell_cmds.c
)

# The sampling interrupt, the block packer and the CRC run for every sample
# at 100 kHz; the rest of the firmware stays size-optimised.
set_source_files_properties(src/sampling.c src/protocol.c PROPERTIES COMPILE_OPTIONS -O2)
