# Joule Counter

A Nordic Power Profiler Kit II, expanded to work as a joule meter.

Out of the box, the PPK2 measures current only. That's fine when the supply
is a fixed voltage from the kit itself, but as soon as the device under test is
running from a battery or a solar cell, the voltage moves, and what you
actually want to know is how much energy it used. This repo replaces the
kit's firmware so that every sample carries the DUT voltage alongside the
current, and forks Nordic's desktop app so it can turn those pairs into
power and energy.

I've used it to tune PV cell maximum power points, and to profile the total energy usage of different operations on a low power microcontroller, at different input voltages.

Using this alternate software is non-breaking. It doesn't overwrite the factory bootloader, and the official PPK2 app will happily prompt you to update your device and overwrite this firmware back to stock.

That said, use at your own risk. I won't take any responsibility, and my sample size is 1.

![Current, power and voltage traces in the Joule Counter app](Joule-Counter/resources/chart-all-traces-5ms.png)

![Two seconds around a supply transient, all three traces](Joule-Counter/resources/chart-transient-2s.png)

![The same two seconds with the current trace turned off; the statistics row drops the current figures too](Joule-Counter/resources/chart-power-voltage-only.png)

## What's in here

| Folder | What it is |
| --- | --- |
| `firmware/` | The Joule Counter firmware (nRF Connect SDK / Zephyr). Streams 100 kHz current + voltage pairs. This is the one you want. |
| `Joule-Counter/` | Fork of Nordic's `pc-nrfconnect-ppk` desktop app that understands the new stream: voltage and power traces, energy in the statistics, extra CSV columns. Runs inside nRF Connect for Desktop. |
| `baseline/` | A from-scratch, wire-compatible reimplementation of the stock PPK2 firmware. `firmware/` is forked from it. Kept because it works with Nordic's unmodified app and is the reference for everything the two share (hardware notes, calibration handling, USB layout). |
| `tools/` | Python scripts for talking to a kit without the app: identify ports, read metadata, stream and summarize samples, back up calibration, package and flash builds over USB. |

## How it works, briefly

The nRF52840's SAADC can scan two channels on one sample trigger, so the
current channel and the `VDUT+` divider are converted back to back and land
in the same DMA buffer. Every sample the host receives is therefore a
current and a voltage reading from within a few microseconds of each
other, which is what makes instantaneous power honest through a pulsed load.
The scan runs at 100 kHz, as fast as it goes for two channels.

To get that through a full-speed USB link, the firmware packs the samples
into 5 ms blocks, storing each field as an offset from the block's minimum
in only as many bits as the block needs: about 8 bits a sample for a steady
signal, never more than 33. Every block carries its position in the stream
and a CRC, so data lost on the way shows up as a gap of exactly the right
length rather than a shifted time axis.

Energy in the app is summed sample by sample (Σ V·I·dt), not
average-current × average-voltage × time. Those two differ exactly when it
matters.

The voltage channel is uncalibrated: it's the board's 120 kΩ/30 kΩ divider
and the ADC's nominal gain, and it lands within about half a percent of the
kit's own oversampled monitor. The current path uses the factory calibration
from the EEPROM unchanged.

## Quick start

You need a PPK2 (PCA63100 rev 1.0.1) and
[nRF Connect for Desktop](https://www.nordicsemi.com/Products/Development-tools/nRF-Connect-for-Desktop).

1. **Install the app.** Download `joule-counter-<version>.tgz` from this
   repository's Releases page and add it in nRF Connect for Desktop with
   *Add local app*, or simply by drag-and-drop to the nRF Connect app.
   Joule Counter appears under *Local apps*.

2. **Plug the kit in and open the app.** It reads the firmware version off
   the kit and offers to program the Joule Counter firmware it bundles.
   Accept. This uses the same update mechanism as Nordic's app, so the
   factory bootloader and the calibration data are untouched.

3. **Measure.** Source-meter and ampere-meter modes work as in the Power
   Profiler app; the chart gains power and voltage traces and the statistics
   row gains energy.

To go back to stock, open Nordic's Power Profiler app instead: it sees an
unfamiliar version string and offers to reprogram the kit with Nordic's
firmware.

## Building from source

**App:** needs [Node.js](https://nodejs.org/). This bundles the JavaScript;
nothing is compiled.

```powershell
cd Joule-Counter
npm install
npm run build:dev
New-Item -ItemType Junction -Path "$env:USERPROFILE\.nrfconnect-apps\local\joule-counter" -Target (Get-Location)
```

Restart the launcher and the working copy runs as a local app. `npm run
check` runs lint and types, `npm test` the unit tests. See
`Joule-Counter/README.md`.

**Firmware:** needs nRF Connect SDK v3.4.1. The build script is PowerShell.

```powershell
cd firmware
.\build.ps1
```

Flash it over USB as described in `tools/README.md`, or with a J-Link on
the SWD header. To have the app carry your build, copy
`firmware/build/firmware/zephyr/zephyr.hex` over
`Joule-Counter/firmware/joule_counter_0.2.0.hex` and keep
`CONFIG_PPK2_DFU_SEMVER` and the version string in
`Joule-Counter/src/components/DeviceSelector.tsx` matching.

**Release:** the version in `Joule-Counter/package.json` is what nRF Connect
for Desktop shows, and the firmware it bundles must be the build that
matches. Bump the version and `Changelog.md`, then:

```powershell
cd Joule-Counter
npm run check
npm test
npm run build:prod
npm pack                                   # joule-counter-<version>.tgz
gh release create v<version> joule-counter-<version>.tgz --title "Joule Counter <version>" --notes-file release-notes.md
```

`npm pack` bundles `dist/`, `firmware/` and `worker/` (the `files` list in
`package.json`), so the tarball installs on its own through *Add local app*.

## Things to know

- Sessions saved by this app store voltage too, so they can't be opened by
  the Power Profiler app, and vice versa.
- Nordic's app will still list a kit running this firmware (same USB
  identity) but can't decode the stream. Flash `baseline/` or stock to go
  back.
- Under *Display options* you can pick which of current, voltage and power
  are drawn; the statistics row follows the same choice.
- The instrumentation amplifier's zero-current offset drifts a little with
  temperature. The firmware re-trims it whenever it knows the current is
  zero (just before it switches the DUT output on), which is also why the
  output takes a moment to come up.

## Licences

`firmware/`, `baseline/` and `tools/` are Apache-2.0 (see the SPDX headers).
`Joule-Counter/` is a fork of Nordic Semiconductor's app and stays under
Nordic's licence; see `Joule-Counter/LICENSE`.

## Is this slop?

Yes. Most of the work here was done with an LLM. It was checked against real hardware at every step, and it does what
it says. But it's a tool for getting a job done, not a project
to be lauded. This tool is something that needs to exist in the world.
