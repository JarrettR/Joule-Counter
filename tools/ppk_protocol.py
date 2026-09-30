"""Wire protocol for the PPK2 data port.

Mirrors baseline/src/ppk2.h (one 32-bit word per sample, the stock PPK2
layout) and firmware/src/ppk2.h (Joule Counter's block stream) exactly --
this is not a general PPK2 client, it is a test harness for our own
firmware. If they drift apart, trust the firmware headers and fix this file.
"""
from __future__ import annotations

import dataclasses
import struct
import time
import zlib
from enum import IntEnum
from typing import Iterator

import serial

# --- one-word sample layout (baseline/src/ppk2.h) ---------------------------

SAMPLE_ADC_MASK = 0x3FFF
SAMPLE_RANGE_POS = 14
SAMPLE_EXT_USB_POS = 17
SAMPLE_COUNTER_POS = 18
SAMPLE_COUNTER_MASK = 0x3F
SAMPLE_LOGIC_POS = 24

RANGE_MISSING = 6      # Joule Counter: a conversion the sampler never saw
RANGE_SWITCHING = 7

# --- block stream (firmware/src/ppk2.h) --------------------------------------

BLOCK_MAGIC = b"JC"
BLOCK_VERSION = 1
# magic, version, flags, first, count, stream, reserved, current base,
# voltage base, range base, logic base, widths current|voltage<<4,
# widths range|logic<<4, crc
BLOCK_HEADER = struct.Struct("<2sBBIHBBHHBBBBI")
BLOCK_CRC_OFFSET = 20
# Firmware blocks carry at most 512 samples; the bound only rejects garbage.
BLOCK_MAX_SAMPLES = 4096

FLAG_EXT_USB = 0x01
FLAG_LAST = 0x02
FLAG_OVERFLOW = 0x04
FLAG_TEST = 0x08

# Field order within a sample, least significant first, and full widths.
FIELD_BITS = (11, 3, 11, 8)   # current, range, voltage, logic


def payload_words(count: int, sample_bits: int) -> int:
    return (count * sample_bits + 31) // 32

class Cmd(IntEnum):
    """Opcodes the data port accepts (firmware/src/ppk2.h: enum ppk2_cmd)."""

    TRIGGER_SET = 0x01
    AVG_NUM_SET = 0x02
    TRIGGER_WINDOW_SET = 0x03
    TRIGGER_INTERVAL_SET = 0x04
    TRIGGER_SINGLE_SET = 0x05
    AVERAGE_START = 0x06
    AVERAGE_STOP = 0x07
    RANGE_SET = 0x08
    LCD_SET = 0x09
    TRIGGER_STOP = 0x0A
    DEVICE_RUNNING_SET = 0x0C
    REGULATOR_SET = 0x0D
    SWITCH_POINT_DOWN = 0x0E
    SWITCH_POINT_UP = 0x0F
    SET_POWER_MODE = 0x11
    RES_USER_SET = 0x12
    SPIKE_FILTERING_ON = 0x15
    SPIKE_FILTERING_OFF = 0x16
    GET_METADATA = 0x19
    RESET = 0x20
    SET_USER_GAINS = 0x25
    LINK_TEST = 0x30  # Joule Counter only: stream a test pattern flat out


class Mode(IntEnum):
    AMPERE = 1
    SOURCE = 2


@dataclasses.dataclass
class Sample:
    """One-word (PPK2 / baseline) sample."""

    adc: int
    range: int
    ext_usb: bool
    counter: int
    logic: int
    word: int = 0


def decode_sample(word: int) -> Sample:
    return Sample(
        word=word,
        adc=word & SAMPLE_ADC_MASK,
        range=(word >> SAMPLE_RANGE_POS) & 0x7,
        ext_usb=bool((word >> SAMPLE_EXT_USB_POS) & 0x1),
        counter=(word >> SAMPLE_COUNTER_POS) & SAMPLE_COUNTER_MASK,
        logic=(word >> SAMPLE_LOGIC_POS) & 0xFF,
    )


@dataclasses.dataclass
class Block:
    """One CRC-checked block of the Joule Counter stream."""

    first: int          # stream index of the first sample
    count: int
    flags: int
    stream: int
    bases: tuple[int, int, int, int]    # current, range, voltage, logic
    widths: tuple[int, int, int, int]
    words: tuple[int, ...]              # the packed samples
    raw: bytes = b""                    # the block as received, header included

    @property
    def sample_bits(self) -> int:
        return sum(self.widths)

    def samples(self) -> Iterator["JcSample"]:
        """Unpacks the block: each field is base + its offset in the bit stream."""
        bits = self.sample_bits
        bc, br, bv, bl = self.bases
        wc, wr, wv, wl = self.widths
        mc, mr, mv, ml = ((1 << w) - 1 for w in self.widths)
        words = self.words + (0,)
        for k in range(self.count):
            pos = k * bits
            j, o = pos >> 5, pos & 31
            x = (words[j] | (words[j + 1] << 32)) >> o if bits else 0
            cur = bc + (x & mc)
            x >>= wc
            rng = br + (x & mr)
            x >>= wr
            volt = bv + (x & mv)
            x >>= wv
            yield JcSample(self.first + k, cur, rng, volt, bl + (x & ml))


@dataclasses.dataclass
class JcSample:
    """One Joule Counter sample; adc and voltage_adc are raw >> 2 (x4 = 14-bit counts)."""

    index: int
    adc: int
    range: int
    voltage_adc: int
    logic: int


def test_block_samples(seed: int, count: int = 512) -> list[tuple[int, int, int, int]]:
    """The samples of a pack-mode link test block: firmware sampling_test_block()."""
    state = seed or 1

    def draw() -> int:
        nonlocal state
        x = state
        x ^= (x << 13) & 0xFFFFFFFF
        x ^= x >> 17
        x ^= (x << 5) & 0xFFFFFFFF
        state = x
        return x

    masks, bases = [], []
    for full in FIELD_BITS:
        masks.append((1 << (draw() % (full + 1))) - 1)
        bases.append(draw() & ((1 << full) - 1))
    return [tuple((b & ~m) | (draw() & m) for b, m in zip(bases, masks))  # type: ignore[misc]
            for _ in range(count)]


class BlockParser:
    """Splits the data port's byte stream into CRC-checked blocks.

    Anything that is not a valid block (a stray metadata reply, bytes from
    before the port was opened, corruption) is skipped byte by byte until the
    next valid header, and counted.
    """

    def __init__(self) -> None:
        self._buf = bytearray()
        self.crc_errors = 0
        self.skipped_bytes = 0

    def feed(self, data: bytes) -> list[Block]:
        buf = self._buf
        buf += data
        out: list[Block] = []
        pos = 0
        while True:
            i = buf.find(BLOCK_MAGIC, pos)
            if i < 0:
                # Keep a trailing 'J': it may be the first half of a magic.
                keep = 1 if buf.endswith(BLOCK_MAGIC[:1]) else 0
                self.skipped_bytes += len(buf) - pos - keep
                pos = len(buf) - keep
                break
            self.skipped_bytes += i - pos
            pos = i
            if len(buf) - pos < BLOCK_HEADER.size:
                break
            (_, version, flags, first, count, stream, reserved, bc, bv, br, bl, wcv, wrl,
             crc) = BLOCK_HEADER.unpack_from(buf, pos)
            widths = (wcv & 0xF, wrl & 0xF, wcv >> 4, wrl >> 4)
            if (version != BLOCK_VERSION or reserved != 0 or count > BLOCK_MAX_SAMPLES
                    or any(w > full for w, full in zip(widths, FIELD_BITS))):
                pos += 1
                self.skipped_bytes += 1
                continue
            words = payload_words(count, sum(widths))
            end = pos + BLOCK_HEADER.size + 4 * words
            if len(buf) < end:
                break
            calc = zlib.crc32(buf[pos + BLOCK_HEADER.size:end],
                              zlib.crc32(buf[pos:pos + BLOCK_CRC_OFFSET]))
            if calc != crc:
                self.crc_errors += 1
                pos += 1
                self.skipped_bytes += 1
                continue
            payload = struct.unpack_from(f"<{words}I", buf, pos + BLOCK_HEADER.size)
            out.append(Block(first, count, flags, stream, (bc, br, bv, bl), widths, payload,
                             bytes(buf[pos:end])))
            pos = end
        del buf[:pos]
        return out


class PPKDataPort:
    """The custom CDC ACM port carrying the PPK2 binary protocol.

    Not the shell port -- see tools/identify.py to tell them apart on a
    given machine, since Windows does not assign COM numbers by USB
    interface order.
    """

    def __init__(self, port: str, timeout: float = 2.0) -> None:
        self._ser = serial.Serial(port, baudrate=115200, timeout=timeout)
        # DTR gates whether our firmware's link-state callback (and so
        # protocol.c's CMD_INTERNAL_LINK) sees this as "connected".
        self._ser.dtr = True
        time.sleep(0.05)

    def close(self) -> None:
        self._ser.close()

    def __enter__(self) -> "PPKDataPort":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def send_command(self, cmd: Cmd, *args: int) -> None:
        self._ser.write(bytes([int(cmd), *args]))

    def get_metadata(self, timeout: float = 1.0) -> str:
        """Sends GetMetadata and reads the text reply up to 'END'.

        Safe to call whether or not a stream is running: the firmware stops
        any running stream before replying (protocol.c: handle_get_metadata),
        and whatever binary data still arrives ahead of the text is skipped.
        """
        self._ser.timeout = timeout
        self.send_command(Cmd.GET_METADATA)
        buf = b""
        deadline = time.monotonic() + timeout * 5
        while time.monotonic() < deadline:
            start = buf.find(b"Calibrated:")
            if start >= 0 and b"END" in buf[start:]:
                break
            chunk = self._ser.read(256)
            if not chunk:
                break
            buf += chunk
        start = buf.find(b"Calibrated:")
        if start >= 0:
            end = buf.find(b"END", start)
            buf = buf[start:] if end < 0 else buf[start:end + 4]
        return buf.decode("ascii", errors="replace")

    def average_start(self) -> None:
        self.send_command(Cmd.AVERAGE_START)

    def average_stop(self) -> None:
        self.send_command(Cmd.AVERAGE_STOP)

    def device_running_set(self, on: bool) -> None:
        self.send_command(Cmd.DEVICE_RUNNING_SET, 1 if on else 0)

    def set_power_mode(self, mode: Mode) -> None:
        self.send_command(Cmd.SET_POWER_MODE, int(mode))

    def regulator_set_mv(self, mv: int) -> None:
        # RegulatorSet takes mV as two bytes, high byte first
        # (baseline/src/protocol.c: (arg[0] << 8) | arg[1]).
        self.send_command(Cmd.REGULATOR_SET, (mv >> 8) & 0xFF, mv & 0xFF)

    def link_test(self, seconds: int, pack: bool = False) -> None:
        """Full-width pattern blocks, or with pack pseudo-random packed samples."""
        self.send_command(Cmd.LINK_TEST, seconds | (0x80 if pack else 0))

    def read_words(self, duration_s: float) -> Iterator[Sample]:
        """Yields one-word (PPK2 / baseline) samples for duration_s of streaming.

        Sends AverageStart on entry and AverageStop on exit/exception, so a
        Ctrl-C mid-stream still leaves the device idle.
        """
        self._ser.timeout = 0.5
        self.average_start()
        try:
            remainder = b""
            deadline = time.monotonic() + duration_s
            while time.monotonic() < deadline:
                chunk = self._ser.read(4096)
                if not chunk:
                    continue
                buf = remainder + chunk
                n = len(buf) - (len(buf) % 4)
                for (word,) in struct.iter_unpack("<I", buf[:n]):
                    yield decode_sample(word)
                remainder = buf[n:]
        finally:
            self.average_stop()

    def read_blocks(self, duration_s: float, parser: BlockParser | None = None,
                    start: bool = True, tail_timeout: float = 2.0) -> Iterator[Block]:
        """Yields Joule Counter blocks for duration_s, then the stream's tail.

        With start set, sends AverageStart first; either way sends
        AverageStop after duration_s and keeps reading until the block
        flagged LAST arrives (or tail_timeout passes), so every sample the
        device took is seen.
        """
        parser = parser or BlockParser()
        self._ser.timeout = 0.05
        if start:
            self.average_start()
        stopped = False
        try:
            deadline = time.monotonic() + duration_s
            while True:
                if not stopped and time.monotonic() >= deadline:
                    self.average_stop()
                    stopped = True
                    deadline = time.monotonic() + tail_timeout
                elif stopped and time.monotonic() >= deadline:
                    return
                chunk = self._ser.read(65536)
                if not chunk:
                    continue
                for block in parser.feed(chunk):
                    yield block
                    if stopped and block.flags & FLAG_LAST:
                        return
        finally:
            if not stopped:
                self.average_stop()
