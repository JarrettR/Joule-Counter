# Joule Counter firmware

Firmware for the Nordic Power Profiler Kit II (PCA63100 rev 1.0.1) that turns
it into a joule meter: every sample carries the DUT current *and* the DUT
voltage from the same SAADC scan, so the paired `Joule-Counter/` desktop app
can compute power and integrate energy. Built on nRF Connect SDK / Zephyr.

This is a fork of `../baseline/`, which is a wire-compatible PPK2
reproduction. The two share the hardware description, calibration handling,
supply-path control and USB composite layout; what differs is the sampler
(two channels instead of one), the wire format (packed, indexed,
CRC-checked blocks), the stream's buffering and the firmware's identity.

Target: **nRF52840-QIAA** (U12, aQFN73) — Cortex-M4F, `ppk2/nrf52840`.


## Building

```powershell
.\build.ps1              # incremental
.\build.ps1 -Pristine    # reconfigure from scratch
.\build.ps1 -Flash       # build, then program over SWD with J-Link
```

`build.ps1` exists because two things are not discoverable automatically: the
nRF Connect SDK toolchain environment, and `BOARD_ROOT`. Sysbuild (which `west
build` uses by default under NCS) does not inherit `BOARD_ROOT` from the
application's `CMakeLists.txt`, so it has to be passed on the command line.

The equivalent by hand:

```powershell
& <path-to>\nrfutil-sdk-manager.exe toolchain env --ncs-version v3.4.1 --as-script powershell |
    Out-String | Invoke-Expression
$env:ZEPHYR_BASE = "C:\ncs\v3.4.1\zephyr"
west build -b ppk2/nrf52840 -d build . -- -DBOARD_ROOT=$PWD
```

Toolchain: nRF Connect SDK **v3.4.1** (Zephyr 4.4.2), installed to `C:\ncs` via
the `nrfutil-sdk-manager.exe` bundled with the nRF Connect VS Code extension.

### Flashing

`zephyr.hex` starts at `0x1000`, above the factory nRF5 bootloader, so
programming it over SWD with `.\build.ps1 -Flash` leaves the bootloader intact.
Once this firmware runs, `ppk dfu` on the shell port (or the desktop app's
firmware update flow) reboots into that bootloader.

## What it does

### Host protocol (USB data port)

The kit enumerates as VID `0x1915` / PID `0xC00A` (unchanged, so the existing
DFU-trigger driver binding keeps working), product string `Joule Counter`,
with Nordic's **DFU trigger** interface first, then the **data port** and the
**shell port** (both CDC ACM). The DFU trigger reports
`CONFIG_PPK2_DFU_SEMVER` = `joule_counter 0.2.0`; the Joule-Counter app
compares that string exactly, so it leaves this firmware alone and offers to
reprogram anything else (stock or `baseline/`) it finds on a kit.

Commands are one opcode byte plus fixed-length arguments. Those the app uses:

| Opcode | Command | Arguments | Effect |
| --- | --- | --- | --- |
| `0x06` | AverageStart | — | start the 100 kHz current+voltage stream |
| `0x07` | AverageStop | — | stop the stream; its tail and a final block go out first |
| `0x0C` | DeviceRunningSet | on (1 byte) | `VOUT_EN`: connect the DUT output |
| `0x0D` | RegulatorSet | mV (2 bytes, big-endian) | source-mode output voltage |
| `0x11` | SetPowerMode | 1 = ampere, 2 = source | select the supply path |
| `0x19` | GetMetadata | — | reply with the calibration text, ending in `END` |
| `0x20` | Reset | — | reboot |
| `0x25` | SetUserGains | range, float32 LE | store a per-range user gain |
| `0x30` | LinkTest | seconds (1–60), +0x80 for packed | send test blocks flat out; `tools/` only (see below) |

PPK1-era opcodes (`0x01`–`0x05`, `0x08`–`0x0A`, `0x0E`–`0x0F`, `0x12`,
`0x15`–`0x16`) are consumed with their argument bytes and ignored.

The stream is a sequence of **blocks**, one USB transfer each, laid out in
`ppk2.h` and decoded by `Joule-Counter/src/device/serialDevice.ts` and
`tools/ppk_protocol.py`. This is not the PPK2 wire format.

A block covers up to 512 consecutive samples (5.12 ms). Its 24-byte header:

| Offset | Size | Content |
| --- | --- | --- |
| 0 | 2 | magic `JC` |
| 2 | 1 | format version, 1 |
| 3 | 1 | flags: bit 0 J1 VBUS present, bit 1 last block of the stream, bit 2 the gap before this block is a ring overflow, bit 3 link test |
| 4 | 4 | stream index of the first sample (LE) |
| 8 | 2 | number of samples, 0–512 (LE) |
| 10 | 1 | stream id, changes with every AverageStart |
| 11 | 1 | reserved, 0 |
| 12 | 2 + 2 | current base, voltage base (LE) |
| 16 | 1 + 1 | range base, logic base |
| 18 | 1 | current width \| voltage width << 4 |
| 19 | 1 | range width \| logic width << 4 |
| 20 | 4 | CRC-32 (the zlib one) of bytes 0–19, then the payload (LE) |

A sample has four fields:

| Field | Values | Content |
| --- | --- | --- |
| current | 0–2047 | the 14-bit differential SAADC result `>> 2`, clamped at 0. The app multiplies by 4, so the EEPROM's `O` offsets are in raw 14-bit counts. |
| range | 0–7 | 0–4 (1 kΩ … 0.05 Ω shunt), 7 while the switches settle, 6 for a conversion the firmware missed |
| voltage | 0–2047 | `VDUT+`, same `>> 2`/clamp convention: AIN4 against AGND, gain 1/3, through the board's 120 kΩ/30 kΩ divider |
| logic | 0–255 | logic port D0–D7 |

The payload stores each field as its offset from the header's base for it,
in the header's width for it: the block's minimum, and just enough bits for
the block's spread. Sample *k* occupies bits *k·W* to *k·W+W−1* of the
payload, *W* being the sum of the widths, fields in the order of the table,
least significant bit first, in 32-bit little-endian words zero-padded at
the end. A steady signal needs about 8 bits a sample, headers included; a
block can never need more than 11 + 3 + 11 + 8 = 33, which bounds the link
load at 416 kB/s.

Every conversion of a stream has a slot, counting from zero at
AverageStart, and the samples of a block are consecutive slots. A block the
host never receives, or one the firmware had to drop because the host read
too slowly (flag bit 2), therefore shows up as a gap of exactly the right
length before the next block, and the time axis never shifts. Scans the
interrupt handler missed keep their slot as range 6, and scans taken while
the range switches were moving keep theirs as range 7; the app holds the
current of the sample before and uses the voltage as measured. The magic,
the header checks and the CRC let a reader resynchronise on anything that is
not a block, such as stale bytes when a port is reopened.

The host converts the voltage linearly, `mV = raw × VFS / 8192 × VDIV`,
with `VFS` (1800) and `VDIV` (5.000) taken from the metadata reply rather
than hard-coded, so a gain/offset calibration can be added later without
another format change. The channel is uncalibrated; expect it to sit within
about 0.5 % of the 40 µs oversampled `vdut` monitor.

`GetMetadata` carries four extra lines before `END`: `VFS`, `VDIV`,
`SampleRate: 100000` and `BlockFormat: 1`. The app reads the rate from
there and refuses a block format it does not know. If a stream is running,
GetMetadata stops it first, and the reply follows the stream's final block.

Blocks are packed from a 32768-sample ring (328 ms at 100 kHz) straight into
USB buffers, up to four queued to the controller at once. If the host stops
reading for longer than the ring covers, the oldest samples are dropped a
block at a time and the next block that goes out is flagged. Closing the
port stops the stream and drops whatever was still queued, so the next
reader starts clean.

LinkTest sends 512-sample blocks flagged as a test for the given number of
seconds, then a final one. Plain, every block is full width (33 bits a
sample, the stream's worst case) with payload word *k* = first + *k*, which
shows what the link sustains. With 0x80 added, the blocks instead carry
pseudo-random samples of every width combination, packed like the stream
and seeded with first + 1, so a host can check its decoder against its own
copy of the generator (`ppktool.py linktest --pack`).

### Measurement chain

- **SAADC two-channel scan.** `CH[0]` is the current: 14-bit differential,
  gain 1/3, internal 0.6 V reference, `VSE_IA` (AIN7) against `AGND` (AIN5),
  the configuration the kit was calibrated with. `CH[1]` is `VDUT+` (AIN4)
  against AGND at the same gain. With both enabled, one `TASKS_SAMPLE`
  converts them back to back into a two-slot EasyDMA buffer and one
  `EVENTS_END` covers the pair, so every sample's V and I are a few
  microseconds apart and the rest of the sampler is unchanged.
- **Burst is off for the scan.** With `CH_CONFIG.BURST` set on two scanned
  channels the SAADC returns the second channel's result in both slots.
  Burst only belongs with oversampling (nrfx ties the two together), so the
  stream leaves it to the oversampled single conversions.
- **Rate: 100 kHz.** Both channels convert within the 10 µs period with
  acquisition-time code 7: the scan ends about 6.8 µs after it is triggered
  (`ppk status` shows where in the period), and the voltage reading is
  insensitive to that code (TACQ 0–5 agree within 0.3 %).
- **TIMER2** at 16 MHz with a 160-tick period fires `TASKS_SAMPLE` through PPI
  every 10 µs; `EVENTS_END` re-arms the two-slot EasyDMA buffer through a
  second PPI channel. The CPU only runs the END interrupt: it reads both
  results and GPIO port 0, decodes the range and stores one 33-bit sample in
  the ring. Packing into blocks happens later, in the protocol thread.
- **Anomaly 212.** Switching the SAADC from the stream's two-channel scan to
  the monitors' single burst channel can leave it broken; on this kit the
  next scan either converted one channel per trigger (half rate, the same
  input in both slots) or delivered the two slots swapped. Every SAADC
  reconfiguration therefore starts with Nordic's documented workaround, a
  power cycle of the peripheral that keeps its offset calibration.
- The **END handler is a zero-latency interrupt** (`CONFIG_ZERO_LATENCY_IRQS`,
  priority 0, above `irq_lock()`), so it makes no kernel calls. **TIMER3**
  counts END events over PPI and interrupts every 512 of them to wake the USB
  sender; that is where the block-ready semaphore comes from. It also tells
  the handler how many scans ended since its last run, so a missed one is
  counted and keeps its slot. **TIMER4** timestamps each END so the handler
  can measure its own latency (`ppk status` prints the histogram).
- **The CPU stays awake while streaming.** Waking this Cortex-M4 from `WFI`
  takes about 12.5 µs (11.5 µs in the POWER constant-latency sub-mode). That
  is more than the 10 µs sample period, so
  `CONFIG_PPK2_STREAM_KEEPS_CPU_AWAKE` makes the idle
  thread skip `WFI` while the stream runs (Zephyr's
  `z_arm_on_enter_cpu_idle()` hook); END-to-handler latency is then about
  1.2 µs. The kit is USB powered and its own draw is not what it measures.
  `ppk sample selftest` runs the sampler without USB output and prints the
  END/ISR counts and the latency histogram.
- **Range** is read from `SW1..SW4` (P0.00, P0.01, P0.26, P0.27). The analog
  front end auto-ranges by itself; the comparators close the bypass switches
  cumulatively, so only the prefix patterns `0000, 0001, 0011, 0111, 1111` are
  valid ranges 0–4. Anything else is a transition, reported as range 7; the
  sample keeps its slot, so the time base stays exact through range changes.
- **SAADC offset calibration** runs once at boot.
- The **slow voltage monitors** (`VLDO`, `VBB`, `VIN`, `VDUT`, all through 5:1
  dividers; `VREF_IA` at gain 4) use 256× oversampled single conversions and
  are only available while the stream is stopped, because the SAADC belongs to
  the stream while it runs.

### Supply path

| Mode | Path | Lines |
| --- | --- | --- |
| Ampere meter (1) | `VIN` terminal → `VDUT+` | `VEXT_EN` on, `VLDO_EN`/`REG_EN` off |
| Source meter (2) | 5 V → ADP2504 buck-boost → ADP1708 LDO → `VDUT+` | `REG_EN` and `VLDO_EN` on, `VEXT_EN` off |

`VOUT_EN` (P1.04) connects `VDUT-` to the `VOUT` terminal in either mode; that
is the app's *Enable power output*. The kit remembers its mode and voltage in
the EEPROM but never powers the output on its own at boot.

Both regulators take their feedback through wipers of the MCP4451 (I2C
`0x2C`): wiper 0 for the buck-boost, wiper 1 for the LDO; a higher code means
a higher output (about +12 mV/step buck-boost, +16 mV/step LDO). The output
voltage is set closed-loop: the wiper is walked while the regulator output is
read back through the SAADC, re-estimating the mV-per-step slope from each
pair of readings, in bounded steps so a connected DUT sees a ramp. The 1 kΩ
calibration load is switched in while tuning so the output capacitors follow
downward steps promptly, and a final pass without it corrects for the LDO's
load regulation. The buck-boost is kept 0.5 V above the LDO (raised first,
lowered last), with a dropout guard. When the app changes the voltage
*during* streaming, the SAADC is busy, so the change is applied from the last
learned slope and refined the moment the stream stops. The `vldo`/`vdut`
monitors read through 5:1 dividers and are good to roughly ±20 mV absolute.

Wiper 3 sets the instrumentation amplifier's zero-current pedestal. The
factory `O0` constant is the raw code range 0 reads at zero current, so that
is the trim target. The pedestal drifts with temperature and with what the
terminals have been doing (a few counts per hour, ~3.6 counts per wiper
step) and enters every range at that range's gain, so it is re-trimmed
whenever current is known to be zero and the analog section is warm: just
before the DUT output is enabled in source mode, plus a first guess 1.5 s
after boot. Automatic trims stay in RAM; `ppk power ia-trim` followed by
`ppk meta save` is the only path that writes the EEPROM `IA` field, which is
otherwise just the boot-time starting point.

### Calibration metadata

Read from EEPROM offset 0 at boot, validated, and reported to the app in the
same text form the stock firmware uses (`Calibrated`, `R0..4`, `GS0..4`,
`GI0..4`, `O0..4`, `VDD`, `HW`, `mode`, `S0..4`, `I0..4`, `UG0..4`, `IA`,
`END`). The layout is the stock one: floats `R` at 0, `GS` at 20, `O` at 40,
`S` at 60, `I` at 80, `GI` at 100, `VDD` (u16) at 120, `UG` at 128, `mode`
at 251, `Calibrated` at 252 and `IA` (u16, unaligned) at 255, in a 257-byte
image; `HW` is not stored but derived from the low 16 bits of `DEVICEID[0]`.
Stock keeps its own CRC-checked backup copy at `0x600`. Range 0's `GS0`/`GI0`
are reported as `1e-19`/`1.0` regardless of what is stored, as stock does,
or the app applies a wild quadratic at range 0.

A kit whose EEPROM holds no plausible shunt values is reported as
uncalibrated with the app's own default constants. User gains, mode and
voltage are written back (debounced, field by field, only when changed) when
the app changes them; the factory constants and the unknown bytes are never
written. `ppk meta backup` keeps a CRC-protected copy of the fields this
firmware owns at offset `0x200`, clear of both stock regions. Three lines
this firmware adds before `END` — `VFS`, `VDIV`, `SampleRate` — describe the
stream's voltage word and rate; they come from constants, not from the
EEPROM. See `../baseline/CALIBRATION.md` for the meaning of each field and
how to back them up.

### Shell (second serial port, 115200 8N1, waits for DTR)

```
ppk status                       state, voltages, stream, ISR, packing and USB metrics
ppk meta read|raw|set|save|defaults|backup
ppk power mode|vdd|out|ia|ia-trim
ppk cal load 100k|10k|1k|100|off   switch a known load across the terminals
ppk cal measure [n] [vse|vref|vldo|vbb|vin|vdut|ntc]
                                   averaged raw ADC of one channel, range, VDUT
ppk sample reset                 clear the stream metrics
ppk sample tacq [I 0-7] [V 0-7]    acquisition-time codes for the next start
ppk sample selftest [s] [spin|idle] [period]
                                   run the sampler with no USB output and
                                   report END/ISR counts and latency
ppk dfu                            reboot into the bootloader
```

### LEDs

Blue breathing: no host. Blue steady: host connected. Green breathing:
streaming. Red is added whenever the DUT output is powered.

## Hardware facts the code depends on

From `../ref/netlist.NET` (the Altium netlist export), the schematic PDF and
the shipped firmware image, cross-checked against
[fabiobaltieri/ppk2-eeprom](https://github.com/fabiobaltieri/ppk2-eeprom) and
the desktop app's source.

- **There is no 32.768 kHz crystal.** X1 is a 32 MHz HFXO; `P0.00/XL1` and
  `P0.01/XL2` carry `SW1`/`SW2`. LFCLK is synthesised from HFCLK
  (`CONFIG_CLOCK_CONTROL_NRF_K32SRC_SYNTH=y`); Zephyr's `XTAL` default would
  hang.
- **The application links at `0x1000`** to keep the factory nRF5 bootloader
  (`CONFIG_FLASH_LOAD_OFFSET`, controlled by `BOARD_HAS_NRF5_BOOTLOADER`).
- **`P0.09`/`P0.10` are the NFCT pins** but carry `LP_EN`/`LP_D0`, hence
  `nfct-pins-as-gpios`.
- **Every MCU-driven control line first gates an N-channel MOSFET**
  (`DMN2050LFDB`, drains crossed: pin 3 = D2, pin 6 = D1). For the `CAL*`
  loads and the LED channels that is the whole story: **active high**. The
  three power switches add a second stage that inverts it: Q2/Q14/Q16 are
  N-channel high-side pairs with gates pulled to the **+8 V rail** — the only
  reason an 8 V rail exists — so they conduct when left alone, and driving
  `VOUT_EN`/`VLDO_EN`/`VEXT_EN` *high* pulls that gate down and **opens** the
  switch. Hence `GPIO_ACTIVE_LOW` for those three, and the 1 MΩ pull-ups to
  3V3 on exactly those lines that park them "off" through reset.
- **`SW1..SW4` are inputs**: pulled up by 4.7 kΩ, pulled low by Q6/Q8 while a
  shunt is in circuit. High means bypassed. The MCU cannot force a range.
- **Shunt ladder**: R41 1 kΩ always in, with 110 Ω, 11 Ω, 1 Ω and 0.051 Ω
  switched in parallel — reproducing the metadata's R0 ≈ 1003, R1 ≈ 101,
  R2 ≈ 10.3 exactly.
- **SoC power**: `VDDH` (Y2) is on P3V3 with all `VDD` pads → normal voltage
  mode; `DCC` (B3) and `DCCH` (AB2) are unconnected → the internal DC/DC cannot
  be used. Regulator nodes are left at SoC defaults.
- **I2C**: `SDA` P0.24, `SCL` P0.25. EEPROM 24CW160 at `0x50` (WP strapped
  low), MCP4451 at `0x2C`.
- **`P1.13` is `REG_EN`** (ADP2504 + ADP1708 enable); `P1.01–03, 08, 10–12,
  14, 15` are unconnected.

### Pinout

| Pin | Net | Function |
| --- | --- | --- |
| P0.00 | `SW1_ONOFF` | range switch 1 status (input) |
| P0.01 | `SW2_ONOFF` | range switch 2 status (input) |
| P0.02 / AIN0 | `VREF_IA` | ADC: instrumentation-amp reference |
| P0.03 / AIN1 | `VLDO` | ADC: LDO output, /5 |
| P0.04 / AIN2 | `VBB` | ADC: buck-boost output, /5 |
| P0.05 / AIN3 | `VIN` | ADC: internal 5 V rail (USB VBUS via Q12/Q18), /5 |
| P0.06 | `VEXT_EN` | `EXT_POWER_IN` terminal → VDUT+ (ampere mode); active low |
| P0.07 | `VLDO_EN` | LDO → VDUT+ (source mode); active low |
| P0.08 | `ANA_EN` | ADP5072 ±rail enable |
| P0.09 | `LP_EN` | logic-port translator enable (NFC1) |
| P0.10 – P0.17 | `LP_D0` – `LP_D7` | logic port channels 0–7 (P0.10 is NFC2) |
| P0.18 | `RESET` | nRESET |
| P0.19 | `RESET_TRIGGER` | on the RESET net |
| P0.20 – P0.23 | `CAL100K`, `CAL10K`, `CAL1K`, `CAL100` | calibration loads R40, R58, R33, R38 |
| P0.24 / P0.25 | `SDA` / `SCL` | I2C |
| P0.26 | `SW3_ONOFF` | range switch 3 status (input) |
| P0.27 | `SW4_ONOFF` | range switch 4 status (input) |
| P0.28 / AIN4 | `VDUT` | ADC: VDUT+, /5 |
| P0.29 / AIN5 | `AGND` | ADC: analog ground reference (negative input) |
| P0.30 / AIN6 | `NTC` | ADC: thermistor |
| P0.31 / AIN7 | `VSE_IA` | ADC: instrumentation-amp output (current) |
| P1.00 | `SWO` | trace |
| P1.04 | `VOUT_EN` | VDUT- → VOUT (DUT power); active low |
| P1.05 – P1.07 | `LEDR`, `LEDG`, `LEDB` | status LEDs (PWM0), via Q15/Q1 |
| P1.09 | `EXT_USB` | J1 VBUS detect, streamed as bit 17 |
| P1.13 | `REG_EN` | ADP2504 + ADP1708 enable |

The same map is in the devicetree as `gpio-line-names` and as the
`nordic,ppk2-control` node the code reads its pins from.

## Known limitations

- **The voltage channel is uncalibrated.** Linear divider/gain maths only.
  The kit's own monitors are good to about ±20 mV absolute (5:1 dividers),
  so a meter on `VDUT+` is the way to check it; a gain/offset pair in the
  metadata reply is the intended place for a correction.
- **The stream is not PPK2-compatible.** Nordic's Power Profiler app lists
  the kit (same VID/PID) but cannot decode two-word samples; only
  `Joule-Counter/` can. To go back, flash `baseline/` or stock.
- **100 kHz is the ADC's limit for two channels**, and the link has room
  above it: on a Linux host the data port carried 578–587 kB/s with the
  sampler idle and 500 kB/s with it running (`ppktool.py linktest`), against
  416 kB/s for a stream whose every block needs the full 33 bits. A steady
  signal needs about a quarter of that. Nordic's own troubleshooting notes
  that some hosts, hubs and ports lose data even at the stock 400 kB/s; the
  328 ms ring and the exact gap reporting are the answer to those, not more
  bandwidth.
- **Factory calibration procedure.** The calibration loads, the IA trim and
  metadata editing are all there, but there is no routine that derives `R`,
  `GS`, `GI`, `O`, `S`, `I` from them. Shipped kits carry factory values in
  EEPROM, so this only matters for a wiped EEPROM.
- **Learned voltage curve persistence** (`CMD_SAVE_VOLTAGE_CURVE` in the stock
  firmware). The tuner re-learns the slope each session; it converges in a
  handful of steps, so nothing is stored.
- **NTC** temperature is measurable but unused.
- **PPK1 trigger commands** are accepted and ignored; the app does not use
  them with a PPK2.
