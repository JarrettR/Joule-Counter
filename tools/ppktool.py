#!/usr/bin/env python3
"""Command-line utilities for talking to a PPK2 running our firmware.

Windows does not assign COM port numbers by USB interface order, so which of
the two enumerated ports is the binary data port and which is the shell can
change between machines or reboots. `identify` tells them apart empirically;
the other subcommands assume you already know (pass it as an argument).

Examples:
    python ppktool.py identify COM20 COM21
    python ppktool.py metadata COM21
    python ppktool.py stream COM21 --seconds 2
    python ppktool.py linktest COM21 --seconds 5
    python ppktool.py shell COM20
"""
from __future__ import annotations

import argparse
import sys
import time
from collections import Counter

import serial

from ppk_protocol import (
    FIELD_BITS,
    FLAG_EXT_USB,
    FLAG_LAST,
    FLAG_OVERFLOW,
    FLAG_TEST,
    RANGE_MISSING,
    RANGE_SWITCHING,
    BlockParser,
    Mode,
    PPKDataPort,
    test_block_samples,
)

# Uncalibrated VDUT: 0.6 V reference at gain 1/3, 13 bits of magnitude,
# through the 120k/30k divider (the VFS/VDIV lines of the metadata).
MV_PER_COUNT = 1800.0 / 8192.0 * 5.0


def probe_port(port: str, timeout: float = 1.0) -> str:
    """Returns 'data', 'shell', or 'unknown' for the given COM port.

    Tries the data-port GetMetadata command first: it is a single byte and
    the shell will just count it as noise (protocol.c and shell_cmds.c both
    ignore bytes they don't recognize), so probing this way first can never
    accidentally trigger a shell command.
    """
    try:
        with PPKDataPort(port, timeout=timeout) as dev:
            reply = dev.get_metadata(timeout=timeout)
    except serial.SerialException as exc:
        return f"error opening port: {exc}"

    if "END" in reply and ("R0:" in reply or "Calibrated" in reply):
        return "data"

    # Not the data port. See if it is a live shell instead.
    try:
        with serial.Serial(port, baudrate=115200, timeout=timeout) as ser:
            ser.dtr = True
            time.sleep(0.1)
            ser.reset_input_buffer()
            ser.write(b"\r\n")
            time.sleep(0.2)
            banner = ser.read(512).decode("ascii", errors="replace")
    except serial.SerialException as exc:
        return f"error opening port: {exc}"

    if "$" in banner or "ppk2" in banner.lower():
        return "shell"

    return "unknown (no recognizable reply)"


def cmd_identify(args: argparse.Namespace) -> None:
    for port in args.ports:
        result = probe_port(port, timeout=args.timeout)
        print(f"{port}: {result}")


def cmd_metadata(args: argparse.Namespace) -> None:
    with PPKDataPort(args.port) as dev:
        print(dev.get_metadata(), end="")


class _Stats:
    """Running count, mean and spread of raw 14-bit counts."""

    def __init__(self) -> None:
        self.n = 0
        self.sum = 0
        self.sq = 0
        self.min: int | None = None
        self.max: int | None = None

    def add(self, raw: int) -> None:
        self.n += 1
        self.sum += raw
        self.sq += raw * raw
        self.min = raw if self.min is None else min(self.min, raw)
        self.max = raw if self.max is None else max(self.max, raw)

    def mean_sd(self) -> tuple[float, float]:
        mean = self.sum / self.n
        return mean, max(self.sq / self.n - mean * mean, 0.0) ** 0.5


def stream_words(dev: PPKDataPort, args: argparse.Namespace) -> None:
    """PPK2 / baseline one-word stream."""
    ranges: Counter[int] = Counter()
    per_range: dict[int, _Stats] = {}
    n = 0
    lost = 0
    expected_counter = None
    dump = open(args.dump, "wb") if args.dump else None

    for s in dev.read_words(args.seconds):
        n += 1
        ranges[s.range] += 1
        # The app scales the 12-bit field by 4 back to 14-bit counts.
        per_range.setdefault(s.range, _Stats()).add(s.adc * 4)
        if dump:
            dump.write(s.word.to_bytes(4, "little"))
        if expected_counter is not None and s.counter != expected_counter:
            lost += (s.counter - expected_counter) & 0x3F
        expected_counter = (s.counter + 1) & 0x3F
    if dump:
        dump.close()

    print(f"samples: {n}")
    if n:
        print(f"implied rate: {n / args.seconds:.0f} Hz (expect ~100000, minus start-up)")
    print(f"counter gaps (lost, modulo 64): {lost}")
    for r in sorted(ranges):
        label = "switching" if r == RANGE_SWITCHING else str(r)
        mean, sd = per_range[r].mean_sd()
        print(f"  range {label}: {ranges[r]} samples ({100 * ranges[r] / n:.1f}%), "
              f"raw adc mean {mean:.1f} sd {sd:.1f} (14-bit counts)")


def stream_blocks(dev: PPKDataPort, args: argparse.Namespace) -> None:
    """Joule Counter block stream: every sample has an index, so loss is exact."""
    parser = BlockParser()
    ranges: Counter[int] = Counter()
    per_range: dict[int, _Stats] = {}
    volt = _Stats()
    logic_seen = 0
    blocks = 0
    received = 0
    expected = None
    gaps = []           # (first missing index, length, device overflow?)
    streams = set()
    flags_seen = 0
    last_block = False
    nbytes = 0
    first_index = None
    dump = open(args.dump, "wb") if args.dump else None

    t0 = time.monotonic()
    for block in dev.read_blocks(args.seconds, parser):
        if block.flags & FLAG_TEST:
            continue
        blocks += 1
        nbytes += len(block.raw)
        streams.add(block.stream)
        flags_seen |= block.flags
        if dump:
            dump.write(block.raw)
        if first_index is None:
            first_index = block.first
            expected = block.first
        if block.first != expected:
            gaps.append((expected, block.first - expected, bool(block.flags & FLAG_OVERFLOW)))
        expected = block.first + block.count
        received += block.count
        last_block = last_block or bool(block.flags & FLAG_LAST)
        for s in block.samples():
            ranges[s.range] += 1
            logic_seen |= s.logic
            if s.range == RANGE_MISSING:
                continue
            volt.add(s.voltage_adc * 4)
            if s.range != RANGE_SWITCHING:
                per_range.setdefault(s.range, _Stats()).add(s.adc * 4)
    elapsed = time.monotonic() - t0
    if dump:
        dump.close()

    slots = (expected - first_index) if first_index is not None else 0
    lost = sum(g[1] for g in gaps)
    print(f"blocks: {blocks} ({nbytes} bytes, {nbytes / max(elapsed, 1e-9) / 1000:.0f} kB/s "
          f"over {elapsed:.2f} s incl. start/stop, {8 * nbytes / max(received, 1):.1f} bits/sample "
          f"with headers), stream id(s) {sorted(streams)}, "
          f"final block {'seen' if last_block else 'MISSING'}")
    print(f"samples: {received} received of {slots} slots "
          f"(index {first_index}..{expected - 1 if expected else 0}), "
          f"{slots / args.seconds:.0f} Hz over the requested {args.seconds} s")
    print(f"lost: {lost} samples in {len(gaps)} gaps"
          + "".join(f"\n  at {g[0]}: {g[1]} ({'device ring overflow' if g[2] else 'in transit'})"
                    for g in gaps[:10]))
    print(f"link: {parser.crc_errors} CRC errors, {parser.skipped_bytes} bytes skipped, "
          f"J1 VBUS {'present' if flags_seen & FLAG_EXT_USB else 'absent'}")
    total = sum(ranges.values())
    for r in sorted(ranges):
        label = {RANGE_SWITCHING: "switching", RANGE_MISSING: "missing"}.get(r, str(r))
        line = f"  range {label}: {ranges[r]} samples ({100 * ranges[r] / total:.2f}%)"
        if r in per_range:
            mean, sd = per_range[r].mean_sd()
            line += f", raw adc mean {mean:.1f} sd {sd:.1f} (14-bit counts)"
        print(line)
    if volt.n:
        mean, sd = volt.mean_sd()
        print(f"  voltage: raw adc mean {mean:.1f} sd {sd:.1f} min {volt.min} max {volt.max} "
              f"(14-bit counts) = {mean * MV_PER_COUNT:.1f} mV, sd {sd * MV_PER_COUNT:.1f} mV")
    print(f"  logic: bits seen high {logic_seen:#04x}")


def cmd_stream(args: argparse.Namespace) -> None:
    print(f"streaming for {args.seconds}s ...", file=sys.stderr)
    with PPKDataPort(args.port) as dev:
        fmt = args.format
        if fmt == "auto":
            fmt = "blocks" if "BlockFormat:" in dev.get_metadata() else "ppk2"
        if fmt == "blocks":
            stream_blocks(dev, args)
        else:
            stream_words(dev, args)


def cmd_linktest(args: argparse.Namespace) -> None:
    """Measures what the USB link sustains, using the firmware's test blocks.

    Plain blocks are full width, the stream's worst case. With --pack they
    carry pseudo-random samples packed like the stream, and every one is
    checked against this side's copy of the generator.
    """
    parser = BlockParser()
    blocks = 0
    bad = 0
    gaps = 0
    expected = 0
    nbytes = 0
    samples = 0
    bits = 0
    t_first = t_end = None

    with PPKDataPort(args.port) as dev:
        dev._ser.reset_input_buffer()
        dev._ser.timeout = 0.05
        dev.link_test(args.seconds, pack=args.pack)
        deadline = time.monotonic() + args.seconds + 5.0
        done = False
        while not done and time.monotonic() < deadline:
            chunk = dev._ser.read(65536)
            if not chunk:
                continue
            now = time.monotonic()
            for block in parser.feed(chunk):
                if not block.flags & FLAG_TEST:
                    continue
                if block.flags & FLAG_LAST:
                    done = True
                    t_end = now
                    break
                if t_first is None:
                    t_first = now
                    expected = block.first
                else:
                    blocks += 1
                    nbytes += len(block.raw)
                if block.first != expected:
                    gaps += 1
                expected = block.first + block.count
                samples += block.count
                bits += block.count * block.sample_bits
                if args.pack:
                    got = [(s.adc, s.range, s.voltage_adc, s.logic) for s in block.samples()]
                    bad += got != test_block_samples(block.first + 1, block.count)
                else:
                    bad += block.widths != FIELD_BITS or any(
                        w != (block.first + k) & 0xFFFFFFFF for k, w in enumerate(block.words))

    if t_first is None or t_end is None or t_end <= t_first:
        sys.exit("no complete link test received")
    elapsed = t_end - t_first
    rate = nbytes / elapsed
    per_s = blocks * 512 / elapsed
    print(f"{blocks} blocks, {nbytes} bytes in {elapsed:.2f} s: {rate / 1000:.0f} kB/s "
          f"= {per_s:,.0f} samples/s at {bits / max(samples, 1):.1f} bits/sample "
          f"({per_s / 100000:.2f}x the 100 kHz stream)")
    print(f"{'decoded samples wrong' if args.pack else 'pattern errors'} in {bad} blocks, "
          f"sequence gaps {gaps}, CRC errors {parser.crc_errors}, "
          f"bytes skipped {parser.skipped_bytes}")


def cmd_output(args: argparse.Namespace) -> None:
    with PPKDataPort(args.port) as dev:
        if args.mode:
            dev.set_power_mode(Mode.SOURCE if args.mode == "source" else Mode.AMPERE)
            time.sleep(0.2)
        if args.vdd is not None:
            dev.regulator_set_mv(args.vdd)
            time.sleep(0.2)
        if args.on is not None:
            dev.device_running_set(args.on)
    print("done")


def cmd_backup_cal(args: argparse.Namespace) -> None:
    """Read-only capture of the unit's calibration, for ../calibration/."""
    with PPKDataPort(args.port) as dev:
        text = dev.get_metadata()

    if "END" not in text:
        sys.exit(f"no complete metadata reply from {args.port}; got {len(text)} bytes")

    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    body = (
        f"PPK2 calibration capture\n"
        f"Captured {stamp} from {args.port} via GetMetadata (0x19), read-only.\n"
        f"Per-unit data -- do not load onto a different PPK2.\n"
        f"See calibration/README.md for field meanings and restore procedure.\n\n"
        f"{text}"
    )

    if args.output:
        with open(args.output, "w", encoding="ascii") as fh:
            fh.write(body)
        print(f"wrote {args.output}")
    else:
        print(body, end="")


def cmd_shell(args: argparse.Namespace) -> None:
    """Thin wrapper around pyserial's miniterm for the shell port."""
    from serial.tools import miniterm

    sys.argv = ["miniterm", args.port, "115200"]
    miniterm.main()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("identify", help="figure out which COM port is which")
    p.add_argument("ports", nargs="+", help="e.g. COM20 COM21")
    p.add_argument("--timeout", type=float, default=1.0)
    p.set_defaults(func=cmd_identify)

    p = sub.add_parser("metadata", help="read calibration metadata (data port)")
    p.add_argument("port")
    p.set_defaults(func=cmd_metadata)

    p = sub.add_parser("stream", help="start sampling, decode, report stats (data port)")
    p.add_argument("port")
    p.add_argument("--seconds", type=float, default=2.0)
    p.add_argument("--dump", metavar="FILE",
                   help="also write the raw stream here (blocks, or 32-bit words for ppk2)")
    p.add_argument("--format", choices=["auto", "blocks", "ppk2"], default="auto",
                   help="blocks = Joule Counter firmware/, ppk2 = one word per sample "
                        "(baseline/, stock); auto asks the metadata")
    p.set_defaults(func=cmd_stream)

    p = sub.add_parser("linktest", help="measure USB throughput with a test pattern (firmware/ only)")
    p.add_argument("port")
    p.add_argument("--seconds", type=int, default=5, choices=range(1, 61), metavar="1-60")
    p.add_argument("--pack", action="store_true",
                   help="pseudo-random packed samples, each checked against the generator")
    p.set_defaults(func=cmd_linktest)

    p = sub.add_parser("output", help="set mode / vdd / DUT power (data port)")
    p.add_argument("port")
    p.add_argument("--mode", choices=["ampere", "source"])
    p.add_argument("--vdd", type=int, metavar="MV")
    p.add_argument("--on", type=int, choices=[0, 1], help="DUT output on/off")
    p.set_defaults(func=cmd_output)

    p = sub.add_parser("backup-cal", help="capture calibration to a file (read-only)")
    p.add_argument("port")
    p.add_argument("-o", "--output", help="file to write; prints to stdout if omitted")
    p.set_defaults(func=cmd_backup_cal)

    p = sub.add_parser("shell", help="open the maintenance shell port (miniterm)")
    p.add_argument("port")
    p.set_defaults(func=cmd_shell)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
