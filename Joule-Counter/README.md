# Joule Counter app

The desktop side of the Joule Counter: a fork of Nordic's
[Power Profiler app](https://github.com/nordicsemi/pc-nrfconnect-ppk) that
understands the current + voltage stream from the `firmware/` in this repository
and turns it into power and energy. It runs inside
[nRF Connect for Desktop](https://www.nordicsemi.com/Products/Development-tools/nRF-Connect-for-Desktop)
like any other app there.

It only works with the Joule Counter firmware. Pointed at a kit running stock
firmware (or `baseline/`), it will offer to reprogram it with the hex it
bundles.

![Current (blue), power (orange) and voltage (purple) over a 5 ms window](resources/chart-all-traces-5ms.png)

## What's different from the Power Profiler app

- Every sample carries the DUT voltage as well as the current, at 100 kHz.
- The stream from the kit is packed and checked: every 5 ms block of samples
  carries its position in the stream and a CRC, so data lost on the way leaves a
  gap of exactly the right length instead of shifting the time axis. Samples
  taken while the range switches change keep their slot, with the current held
  from the sample before and the voltage as measured.
- Missing data is shown, not hidden. Where samples never arrived, the traces
  cross the gap in red over a light red band (at least a few pixels wide, so a
  short gap still shows when zoomed out), on the chart and on the minimap. The
  window and selection statistics get a red _lost data_ figure when their range
  has a gap, and count the missing samples at the mean of the rest for charge
  and energy. A _Data integrity_ row under them counts, for the recording, the
  lost time and samples, the gaps, how many of those were the kit's buffer
  overflowing (the computer not reading fast enough) and how many blocks failed
  their CRC. Hovering a figure explains it.
- Power and voltage traces on the chart, each on its own axis. _Display options_
  has toggles for current, voltage and power; the statistics row under the chart
  follows the same toggles.
- Energy (µJ/mJ/J) in the window and selection statistics, summed sample by
  sample as Σ V·I·dt, plus average voltage and average power. Charge is still
  there.
- Voltage and power columns in the CSV export.
- The sample rate, and the scale of the voltage readings, are read from the
  firmware's metadata reply rather than assumed.

Everything else — the source-meter controls, digital channels, triggers,
minimap, spike filter — is as upstream.

![Two seconds around a supply transient, all three traces](resources/chart-transient-2s.png)

![The same two seconds with the current trace turned off; the statistics row drops the current figures too](resources/chart-power-voltage-only.png)

Shift-drag selects a range; the _Selection_ row then gives the same figures for
just that range. Here a single 620 µs pulse comes out at 0.45 µC and 1.27 µJ:

![A single pulse selected, with charge and energy for the selection alone](resources/chart-selection-pulse.png)

## Installation

nRF Connect for Desktop loads local apps from
`%USERPROFILE%\.nrfconnect-apps\local\` (`~/.nrfconnect-apps/local/` on macOS
and Linux). Build the app once, then point a directory junction or symlink from
there at this folder:

```powershell
npm install
npm run build:dev
New-Item -ItemType Junction -Path "$env:USERPROFILE\.nrfconnect-apps\local\joule-counter" -Target (Get-Location)
```

Restart the launcher and the app shows up under _Local apps_. The firmware hex
the app programs lives in `firmware/` here; copy a fresh build of
`../firmware/build/firmware/zephyr/zephyr.hex` over it when the firmware
changes, and keep the version string in `src/components/DeviceSelector.tsx` in
step with `CONFIG_PPK2_DFU_SEMVER`.

## Development

```powershell
npm run build:dev      # esbuild, output in dist/
npm run watch:types    # tsc in watch mode
npm run check          # lint, types, licence headers, app metadata
npm test               # jest
npm run build:prod     # minified bundle for a release
npm pack               # joule-counter-<version>.tgz, installable with "Add local app"
```

Nordic's
[app development docs](https://nordicsemi.github.io/pc-nrfconnect-docs/) cover
the framework. The parts specific to this fork are in
`src/device/serialDevice.ts` (parsing the block stream), `src/globals.ts` (the
stored frame format), `src/components/Chart/data/dataAccumulator.ts`
(power/voltage aggregation and the energy sum) and
`src/components/Chart/AmpereChart.tsx` (the extra traces and axes).

## File format

Sessions are saved as `*.ppk2` zip files with the same three members as upstream
(`session.raw`, `minimap.raw`, `metadata.json`), but the frame in `session.raw`
is 10 bytes rather than 6:

- 4 bytes: current, float32 little-endian, µA
- 4 bytes: DUT voltage, float32 little-endian, V (NaN if none was recorded)
- 2 bytes: digital channels, 2 bits per channel, as upstream

`metadata.json` carries `formatVersion: 3` and the `frameSize`. The app refuses
sessions without a matching frame size, so files from the Power Profiler app
don't open here and files from here don't open there. There's no guarantee the
format won't change again.

Current values below 0.2 µA are stored as 0, as upstream; voltage is stored as
measured. A sample that never arrived is stored with both current and voltage
NaN, which is how the chart finds the gaps again when the session is opened.

`metadata.json` also carries `integrity`, the _Data integrity_ counts of the
recording, and `minimap.raw` a count of missing samples per minimap point. Both
are optional: sessions without them open, with the gaps still marked on the
chart from the NaN samples.

## Feedback

Issues and pull requests on this repository, please — not Nordic's DevZone,
which has nothing to do with this fork.

## Licence

This is a fork of Nordic Semiconductor's Power Profiler app and stays under
Nordic's licence. See [LICENSE](LICENSE).
