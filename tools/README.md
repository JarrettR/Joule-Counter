# PPK2 host utilities

Small scripts for talking to a PPK2 running community firmware
directly over USB serial, without going through nRF Connect. Useful for
quick checks and for anything scripted. They work with both firmwares in
this repository (`baseline/`, PPK2 wire-compatible; `firmware/`, Joule
Counter) and, for the read-only commands, with Nordic's stock firmware.

| Script | Purpose |
| --- | --- |
| `ppktool.py` | Command-line front end: identify ports, read metadata, stream and summarise samples, set mode/voltage/output, back up calibration, open the shell |
| `ppk_protocol.py` | The reusable piece (`PPKDataPort`, `Cmd`, `decode_sample`) for one-off scripting |
| `dfu_pkg.py` | Wraps a built `zephyr.hex` into the nRF5 DFU zip that `nrfutil device program` needs |
| `dfu_trigger_probe.py` | Reads the DFU-trigger interface (firmware size, version string) over WinUSB; read-only |

## Setup

```powershell
cd tools
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
```

## The two COM ports

The kit enumerates one DFU-trigger interface (no COM port) and two CDC ACM
ports. The layout is fixed by Nordic's Windows driver, which binds the DFU
trigger by hardware ID `…&MI_00`:

| Interface | Role |
| --- | --- |
| MI_00 | DFU trigger (WinUSB, "nRF Connect DFU Trigger") |
| MI_01 | Binary protocol (data port) |
| MI_03 | Shell (`ppk` commands, logging) |

Windows does not hand out COM numbers in interface order, and they change
whenever the device's serial number changes, so do not assume. Either look
under Device Manager → device properties → Details → *Device instance path*
for `MI_01` vs `MI_03`, or run `identify`, which tells the two apart by
talking to them.

The VID/PID (`1915:C00A`) is the same for stock firmware and for both of
ours. To tell them apart, open the shell port: ours answers with a `ppk2:~$`
prompt and a single `ppk` command tree; stock has a `shell:~$` prompt and
`dfu version` reports `power_profiler_kit_2 …`.

## Usage

```powershell
# Which port is which (safe against any candidate ports)
python ppktool.py identify COM20 COM21

# Calibration metadata, as the desktop app receives it
python ppktool.py metadata COM21

# Save that reply to a file (read-only; see ../baseline/CALIBRATION.md)
python ppktool.py backup-cal COM21 -o my-kit.txt

# Stream for 2 s: samples, exact losses, per-range raw ADC mean/spread
python ppktool.py stream COM21 --seconds 2                 # format taken from the metadata
python ppktool.py stream COM21 --seconds 2 --dump raw.bin  # keep the raw stream too

# What the USB link carries (firmware/ only)
python ppktool.py linktest COM21 --seconds 5         # full-width blocks: the stream's worst case
python ppktool.py linktest COM21 --seconds 5 --pack  # packed pseudo-random samples, all checked

# Mode, source-mode voltage, DUT output
python ppktool.py output COM21 --mode source --vdd 3300 --on 1

# Maintenance shell (miniterm; Ctrl-] to exit)
python ppktool.py shell COM20
```

`stream` asks for the metadata first: a `BlockFormat` line means the Joule
Counter block stream (`firmware/`), otherwise it reads one word per sample
(`baseline/`, stock); `--format` overrides that. For the block stream the
summary gives the bits per sample the packing achieved, every gap in the
sample index with its cause (the kit's ring overflowing, or lost on the
way), CRC errors, and the voltage channel's raw mean and spread with its
uncalibrated conversion to millivolts (`raw × 1800 / 8192 × 5`, matching the
`VFS`/`VDIV` lines in the metadata reply).

`linktest` has the firmware send test blocks as fast as the host takes
them. Plain ones are full width, 33 bits a sample, so the result is what
the link carries for the stream's worst case (the stream itself needs
416 kB/s at most). With `--pack` they carry pseudo-random samples of every
width combination, and each one is compared with this side's copy of the
generator, a check of the packing end to end.

## Flashing over USB

No debugger is needed: the factory nRF5 bootloader stays in place and the
kit is reprogrammed through it.

```powershell
# 1. Package the build
python dfu_pkg.py ..\firmware\build\firmware\zephyr\zephyr.hex -o pkg.zip

# 2. Put the kit into the bootloader
#    - our firmware: on the shell port, run `ppk dfu`
#    - stock firmware: skip this; nrfutil triggers it through the DFU interface
python ppktool.py shell COM20

# 3. Program (serial number from `nrfutil device list`)
nrfutil device program --firmware pkg.zip --serial-number <serial>
```

`nrfutil device` is an nrfutil sub-command that has to be installed
separately. If you have nRF Connect for Desktop, its bundled copy can be run
directly:
`%LOCALAPPDATA%\Programs\nrfconnect\resources\app.asar.unpacked\resources\nrfutil-sandboxes\<ver>\device\<ver>\bin\nrfutil-device.exe program …`

The desktop app does the same thing when it offers to update a kit; the
manual route is for builds the app does not bundle.

## Checking the measurement chain without the app

The shell's `ppk cal load 100k|10k|1k|100|off` switches an on-board
calibration resistor across the terminals, and `ppk cal measure [n]
[vse|vref|vldo|vbb|vin|vdut|ntc]` returns an averaged raw ADC reading of one
channel together with the range and the DUT voltage. Combined with the raw
per-range statistics from `ppktool.py stream`, that is enough to check the
current chain against known currents (V/R at the reported VDUT) and the
voltage channel against the oversampled monitor, with no app involved.
