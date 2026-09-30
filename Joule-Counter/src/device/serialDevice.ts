/*
 * Copyright (c) 2015 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-4-Clause
 */
/* eslint-disable @typescript-eslint/no-non-null-assertion -- TODO: Remove, only added for conservative refactoring to typescript */
/* eslint-disable @typescript-eslint/no-explicit-any -- TODO: Remove, only added for conservative refactoring to typescript */

import {
    type Device as SharedDevice,
    getAppDir,
    logger,
} from '@nordicsemiconductor/pc-nrfconnect-shared';
import { fork } from 'child_process';
import path from 'path';

import PPKCmd from '../constants';
import { type SpikeFilter } from '../utils/persistentStore';
import Device, { convertFloatToByteBuffer } from './abstractDevice';
import {
    type modifiers,
    type SampleValues,
    type serialDeviceMessage,
    type StreamIntegrity,
} from './types';

/* eslint-disable no-bitwise */

// Joule Counter block stream (firmware/src/ppk2.h). A 24-byte header, then
// the block's samples as one little-endian bit stream. A sample holds four
// fields, least significant first: current, range, voltage, logic. Each is
// stored as its offset from the header's base for that field, in the
// header's width for it. Both ADC fields are raw >> 2.
const BLOCK_MAGIC = Buffer.from('JC', 'latin1');
const BLOCK_VERSION = 1;
const BLOCK_HEADER_SIZE = 24;
const BLOCK_CRC_OFFSET = 20;
// The firmware sends at most 512 samples a block; this only rejects garbage.
const BLOCK_MAX_SAMPLES = 4096;
// Full width of current, range, voltage and logic.
const FIELD_BITS = [11, 3, 11, 8];

export const BlockFlag = {
    ExtUsb: 0x01,
    Last: 0x02, // the stream stopped; nothing follows
    Overflow: 0x04, // the gap before this block is a device ring overflow
    Test: 0x08, // link test pattern, not measurements
};

const RANGE_MISSING = 6; // a conversion the firmware never saw
const RANGE_SWITCHING = 7; // the range switches were in transition

// At most this many placeholder samples are emitted for one gap (10 s at
// 100 kHz); anything longer means the time base is lost anyway.
const MAX_GAP_FILL = 1_000_000;

const DATALOSS_THRESHOLD = 500; // samples of loss tolerated before reporting

const payloadWords = (count: number, sampleBits: number) =>
    Math.ceil((count * sampleBits) / 32);

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

// CRC-32 as zlib computes it, over data[start, end), continuing from seed.
export const crc32 = (
    data: Uint8Array,
    start: number,
    end: number,
    seed = 0,
): number => {
    let c = ~seed;
    for (let i = start; i < end; i += 1) {
        c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    }
    return ~c >>> 0;
};

export interface Block {
    flags: number;
    /** Stream index of the first sample. */
    first: number;
    count: number;
    stream: number;
    /** Current, range, voltage and logic: base value and bits per sample. */
    bases: number[];
    widths: number[];
    /** The whole block, header included. */
    data: Buffer;
}

// What a block header at pos says, or 'invalid', or 'short' when more
// bytes are needed to tell.
const checkBlock = (buf: Buffer, pos: number) => {
    if (buf.length - pos < BLOCK_HEADER_SIZE) return 'short';

    const count = buf.readUInt16LE(pos + 8);
    const widths = [
        buf[pos + 18] & 0xf,
        buf[pos + 19] & 0xf,
        buf[pos + 18] >>> 4,
        buf[pos + 19] >>> 4,
    ];
    if (
        buf[pos + 2] !== BLOCK_VERSION ||
        buf[pos + 11] !== 0 ||
        count > BLOCK_MAX_SAMPLES ||
        widths.some((width, i) => width > FIELD_BITS[i])
    ) {
        return 'invalid';
    }

    const sampleBits = widths.reduce((sum, width) => sum + width, 0);
    const end = pos + BLOCK_HEADER_SIZE + 4 * payloadWords(count, sampleBits);
    if (buf.length < end) return 'short';

    const crc = crc32(
        buf,
        pos + BLOCK_HEADER_SIZE,
        end,
        crc32(buf, pos, pos + BLOCK_CRC_OFFSET),
    );
    if (crc !== buf.readUInt32LE(pos + BLOCK_CRC_OFFSET)) return 'corrupt';

    return {
        flags: buf[pos + 3],
        first: buf.readUInt32LE(pos + 4),
        count,
        stream: buf[pos + 10],
        bases: [
            buf.readUInt16LE(pos + 12),
            buf[pos + 16],
            buf.readUInt16LE(pos + 14),
            buf[pos + 17],
        ],
        widths,
        data: buf.subarray(pos, end),
    };
};

// The fields of every sample of a block, in the order of FIELD_BITS.
export const unpackBlock = ({ data, count, bases, widths }: Block) => {
    const sampleBits = widths.reduce((sum, width) => sum + width, 0);
    const nWords = payloadWords(count, sampleBits);
    // One spare word, so a field ending in the last word can read past it.
    const words = new Uint32Array(nWords + 1);
    for (let j = 0; j < nWords; j += 1) {
        words[j] = data.readUInt32LE(BLOCK_HEADER_SIZE + 4 * j);
    }

    const take = (bit: number, width: number) => {
        const j = bit >>> 5;
        const shift = bit & 31;
        const value =
            shift + width > 32
                ? (words[j] >>> shift) | (words[j + 1] << (32 - shift))
                : words[j] >>> shift;
        return value & ((1 << width) - 1);
    };

    const fields = FIELD_BITS.map(() => new Uint16Array(count));
    for (let k = 0; k < count; k += 1) {
        let bit = k * sampleBits;
        for (let f = 0; f < 4; f += 1) {
            fields[f][k] = bases[f] + take(bit, widths[f]);
            bit += widths[f];
        }
    }
    return fields;
};

// Splits the data port's byte stream into CRC-checked blocks. Anything that
// is not a valid block is skipped byte by byte until the next valid header,
// so a stray reply or a corrupted stretch costs only itself.
export const createBlockParser = () => {
    let pending: Buffer = Buffer.alloc(0);
    const stats = { crcErrors: 0, skippedBytes: 0 };

    const feed = (chunk: Buffer, onBlock: (block: Block) => void) => {
        const buf =
            pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
        let pos = 0;

        while (pos < buf.length) {
            const start = buf.indexOf(BLOCK_MAGIC, pos);
            if (start < 0) {
                // Keep a trailing 'J': it may be the first half of a magic.
                const keep = buf[buf.length - 1] === BLOCK_MAGIC[0] ? 1 : 0;
                stats.skippedBytes += buf.length - keep - pos;
                pos = buf.length - keep;
                break;
            }
            stats.skippedBytes += start - pos;
            pos = start;

            const block = checkBlock(buf, pos);
            if (block === 'short') break;
            if (typeof block === 'object') {
                onBlock(block);
                pos += block.data.length;
            } else {
                if (block === 'corrupt') stats.crcErrors += 1;
                stats.skippedBytes += 1;
                pos += 1;
            }
        }

        pending = buf.subarray(pos);
    };

    return { feed, stats };
};

// TODO: How to implement onSampleCallback and open, they are defined in the deviceActions file
class SerialDevice extends Device {
    public modifiers: modifiers = {
        r: [1031.64, 101.65, 10.15, 0.94, 0.043],
        gs: [1, 1, 1, 1, 1],
        gi: [1, 1, 1, 1, 1],
        o: [0, 0, 0, 0, 0],
        s: [0, 0, 0, 0, 0],
        i: [0, 0, 0, 0, 0],
        ug: [1, 1, 1, 1, 1],
    };

    public adcSamplingTimeUs = 10;
    public resistors = { hi: 1.8, mid: 28, lo: 500 };
    public vdd = 5000;
    public vddRange = { min: 800, max: 5000 };
    public triggerWindowRange = { min: 1, max: 100 };
    public isRunningInitially = false;

    private adcMult = 1.8 / 163840;

    // Voltage word scale, overwritten from the device's metadata (VFS/VDIV):
    // 0.6 V reference at gain 1/3 gives 1800 mV over 13 bits of magnitude,
    // behind a 5:1 divider. Uncalibrated.
    private voltageScale = { fullScaleMv: 1800, divider: 5 };

    // This are all declared to make typescript aware of their existence.
    private spikeFilter;
    private path;
    private child;
    private parser: any;
    private blockParser = createBlockParser();
    // The stream this device is decoding, and while a start is pending the
    // one before it, whose tail may still be in flight.
    private streamId: number | undefined;
    private previousStreamId: number | undefined;
    private awaitingStream = false;
    private nextIndex = 0;
    private lastCurrent: number | undefined;
    private dataLossCounter: number;
    private integrity = {
        lostSamples: 0,
        gaps: 0,
        kitOverflows: 0,
        crcErrorsBefore: 0,
        // the previous sample was a missed conversion (range 6)
        inMissedRun: false,
    };
    private rollingAvg: undefined | number;
    private rollingAvg4: undefined | number;
    private prevRange: undefined | number;
    private afterSpike: undefined | number;
    private consecutiveRangeSample: undefined | number;

    constructor(
        device: SharedDevice,
        onSampleCallback: (values: SampleValues) => void,
    ) {
        super(onSampleCallback);

        this.capabilities.maxContinuousSamplingTimeUs = this.adcSamplingTimeUs;
        this.capabilities.samplingTimeUs = this.adcSamplingTimeUs;
        this.capabilities.digitalChannels = true;
        this.capabilities.prePostTriggering = true;
        this.spikeFilter = {
            alpha: 0.18,
            alpha5: 0.06,
            samples: 3,
        };
        this.path = device.serialPorts?.at(0)?.comName;
        const workerFile =
            process.platform === 'darwin'
                ? 'serialDevice.darwin.js'
                : 'serialDevice.js';
        // Structured-clone IPC hands the worker's buffers over as bytes; the
        // default JSON channel would spell every byte out as a number.
        this.child = fork(path.resolve(getAppDir(), 'worker', workerFile), {
            serialization: 'advanced',
        });
        this.parser = null;
        this.resetDataLossCounter();

        this.child.on('message', (message: serialDeviceMessage) => {
            if (!this.parser) {
                console.error('Program logic error, parser is not set.');
                return;
            }

            if (ArrayBuffer.isView(message)) {
                this.parser(
                    Buffer.from(
                        message.buffer,
                        message.byteOffset,
                        message.byteLength,
                    ),
                );
                return;
            }
            if ('data' in message && message.data) {
                this.parser(Buffer.from(message.data));
                return;
            }
            if ('error' in message) {
                logger.error(message.error);
                return;
            }
            console.log(`message: ${JSON.stringify(message)}`);
        });
        this.child.on('close', code => {
            if (code) {
                console.log(`Child process exited with code ${code}`);
            } else {
                console.log('Child process cleanly exited');
            }
        });
        this.dataLossCounter = 0;
    }

    resetDataLossCounter() {
        this.dataLossCounter = 0;
    }

    getAdcResult(range: number, adcVal: number): number {
        const resultWithoutGain =
            (adcVal - this.modifiers.o[range]) *
            (this.adcMult / this.modifiers.r[range]);
        let adc =
            this.modifiers.ug[range] *
            (resultWithoutGain *
                (this.modifiers.gs[range] * resultWithoutGain +
                    this.modifiers.gi[range]) +
                (this.modifiers.s[range] * (this.currentVdd / 1000) +
                    this.modifiers.i[range]));

        const prevRollingAvg4 = this.rollingAvg4;
        const prevRollingAvg = this.rollingAvg;

        this.rollingAvg =
            this.rollingAvg === undefined
                ? adc
                : this.spikeFilter.alpha * adc +
                  (1.0 - this.spikeFilter.alpha) * this.rollingAvg;
        this.rollingAvg4 =
            this.rollingAvg4 === undefined
                ? adc
                : this.spikeFilter.alpha5 * adc +
                  (1.0 - this.spikeFilter.alpha5) * this.rollingAvg4;

        if (this.prevRange === undefined) {
            this.prevRange = range;
        }

        if (this.prevRange !== range || this.afterSpike! > 0) {
            if (this.prevRange !== range) {
                // number of measurements after the spike which still to be averaged
                this.consecutiveRangeSample = 0;
                this.afterSpike = this.spikeFilter.samples;
            } else {
                this.consecutiveRangeSample! += 1;
            }
            // Use previous rolling average if within first two samples of range 4
            if (range === 4) {
                if (this.consecutiveRangeSample! < 2) {
                    this.rollingAvg4 = prevRollingAvg4;
                    this.rollingAvg = prevRollingAvg;
                }
                adc = this.rollingAvg4!;
            } else {
                adc = this.rollingAvg;
            }
            // adc = range === 4 ? this.rollingAvg4 : this.rollingAvg;
            this.afterSpike! -= 1;
        }
        this.prevRange = range;

        return adc;
    }

    start() {
        this.child.send({ open: this.path });
        return this.getMetadata();
    }

    parseMeta(meta: any) {
        Object.entries(this.modifiers).forEach(
            ([modifierKey, modifierArray]) => {
                Array.from(modifierArray).forEach((modifier, index) => {
                    modifierArray[index] =
                        meta[`${modifierKey}${index}`] || modifier;
                });
            },
        );
        // Keys arrive lower-cased: VFS, VDIV and SampleRate from the firmware.
        if (meta.vfs > 0) this.voltageScale.fullScaleMv = meta.vfs;
        if (meta.vdiv > 0) this.voltageScale.divider = meta.vdiv;
        if (meta.samplerate > 0) {
            this.adcSamplingTimeUs = 1e6 / meta.samplerate;
            this.capabilities.maxContinuousSamplingTimeUs =
                this.adcSamplingTimeUs;
            this.capabilities.samplingTimeUs = this.adcSamplingTimeUs;
        }
        if (meta.blockformat !== BLOCK_VERSION) {
            throw new Error(
                `The kit's firmware streams format ${meta.blockformat}, this app reads ${BLOCK_VERSION}. Reprogram the kit from this app.`,
            );
        }
        return meta;
    }

    // Raw 14-bit VDUT count to volts, dividers included.
    getVoltageResult(adcVal: number): number {
        return (
            ((adcVal * this.voltageScale.fullScaleMv) / 8192) *
            this.voltageScale.divider *
            1e-3
        );
    }

    stop() {
        this.child.kill();
    }

    sendCommand(cmd: PPKCmd) {
        if (cmd.constructor !== Array) {
            this.emit(
                'error',
                'Unable to issue command',
                'Command is not an array',
            );
            return undefined;
        }
        if (cmd[0] === PPKCmd.AverageStart) {
            this.rollingAvg = undefined;
            this.rollingAvg4 = undefined;
            this.prevRange = undefined;
            this.consecutiveRangeSample = 0;
            this.afterSpike = 0;
        }
        this.child.send({ write: cmd });
        return Promise.resolve(cmd.length);
    }

    dataLossReport(missingSamples: number, deviceOverflow: boolean) {
        if (
            this.dataLossCounter < DATALOSS_THRESHOLD &&
            this.dataLossCounter + missingSamples >= DATALOSS_THRESHOLD
        ) {
            logger.error(
                deviceOverflow
                    ? 'Data loss: the kit had to discard samples because they were not read out fast enough.'
                    : 'Data loss detected on the USB link. See https://github.com/nordicsemi/pc-nrfconnect-ppk/blob/main/doc/docs/troubleshooting.md#data-loss-with-ppk2',
            );
        }
        this.dataLossCounter += missingSamples;
    }

    handleBlock(block: Block) {
        if (block.flags & BlockFlag.Test) return;

        if (this.awaitingStream) {
            // Blocks of the stream before the latest start can still be
            // in flight; the first block of any other stream is the one
            // that was asked for.
            if (block.stream === this.previousStreamId) return;
            this.streamId = block.stream;
            this.awaitingStream = false;
            this.nextIndex = 0;
        } else if (block.stream !== this.streamId) {
            return;
        }

        // Stream indices are 32-bit and wrap after about 12 hours.
        const gap = (block.first - this.nextIndex) | 0;
        if (gap < 0) return;
        if (gap > 0) {
            const overflow = (block.flags & BlockFlag.Overflow) !== 0;
            this.integrity.lostSamples += gap;
            this.integrity.gaps += 1;
            if (overflow) this.integrity.kitOverflows += 1;
            this.integrity.inMissedRun = false;
            this.dataLossReport(gap, overflow);
            // Missing samples keep their time slots.
            const fill = Math.min(gap, MAX_GAP_FILL);
            for (let i = 0; i < fill; i += 1) {
                this.onSampleCallback({});
            }
        }

        this.emitSamples(block);
        this.nextIndex = (block.first + block.count) >>> 0;
    }

    emitSamples(block: Block) {
        const [current, range, voltage, logic] = unpackBlock(block);

        for (let k = 0; k < block.count; k += 1) {
            if (range[k] === RANGE_MISSING) {
                this.integrity.lostSamples += 1;
                if (!this.integrity.inMissedRun) this.integrity.gaps += 1;
                this.integrity.inMissedRun = true;
                this.onSampleCallback({});
            } else {
                this.integrity.inMissedRun = false;
                const bits = logic[k];
                const volts = this.getVoltageResult(voltage[k] * 4);

                if (range[k] === RANGE_SWITCHING) {
                    // Mid-transition the current reading belongs to neither
                    // range; hold the last one. Voltage and logic are valid.
                    this.onSampleCallback({
                        value: this.lastCurrent,
                        voltage: volts,
                        bits,
                    });
                } else if (range[k] < this.modifiers.r.length) {
                    const value =
                        this.getAdcResult(range[k], current[k] * 4) * 1e6;
                    this.lastCurrent = value;
                    this.onSampleCallback({ value, voltage: volts, bits });
                } else {
                    this.onSampleCallback({});
                }
            }
        }
    }

    parseMeasurementData(buf: Buffer) {
        this.blockParser.feed(buf, block => this.handleBlock(block));
    }

    getMetadata() {
        let metadata = '';
        return (
            new Promise(resolve => {
                this.parser = (data: Buffer) => {
                    // Blocks still in flight from an earlier stream can
                    // arrive ahead of the reply; it starts at its first key.
                    metadata = `${metadata}${data.toString('latin1')}`;
                    const start = metadata.indexOf('Calibrated:');
                    if (start < 0) {
                        metadata = metadata.slice(-16);
                        return;
                    }
                    const end = metadata.indexOf('END', start);
                    if (end >= 0) {
                        this.parser = this.parseMeasurementData.bind(this);
                        resolve(metadata.slice(start, end));
                    }
                };
                this.sendCommand([PPKCmd.GetMetadata]);
            })
                // convert output string json:
                .then(meta => {
                    // TODO: Is this the best way to handle this?
                    // What if typeof meta is not 'string', even though we never expect it,
                    // shouldn't we handle it anyway. And how should then handle it?
                    if (typeof meta === 'string') {
                        return meta
                            .trim()
                            .toLowerCase()
                            .replace(/-nan/g, 'null')
                            .replace(/\n/g, ',\n"')
                            .replace(/: /g, '": ');
                    }
                })
                .then(meta => `{"${meta}}`)
                // resolve with parsed object:
                .then(JSON.parse)
        );
    }

    // Capability methods

    ppkSetPowerMode(isSmuMode: boolean): Promise<unknown> {
        return this.sendCommand([PPKCmd.SetPowerMode, isSmuMode ? 2 : 1])!;
    }

    ppkSetUserGains(range: number, gain: number): Promise<unknown> {
        this.modifiers.ug[range] = gain;
        return this.sendCommand([
            PPKCmd.SetUserGains,
            range,
            ...convertFloatToByteBuffer(gain),
        ])!;
    }

    ppkSetSpikeFilter(spikeFilter: SpikeFilter): void {
        this.spikeFilter = {
            ...this.spikeFilter,
            ...spikeFilter,
        };
    }

    getStreamIntegrity(): StreamIntegrity {
        return {
            lostSamples: this.integrity.lostSamples,
            gaps: this.integrity.gaps,
            kitOverflows: this.integrity.kitOverflows,
            crcErrors:
                this.blockParser.stats.crcErrors -
                this.integrity.crcErrorsBefore,
            samplingTimeUs: this.adcSamplingTimeUs,
        };
    }

    ppkAverageStart() {
        this.resetDataLossCounter();
        this.integrity = {
            lostSamples: 0,
            gaps: 0,
            kitOverflows: 0,
            crcErrorsBefore: this.blockParser.stats.crcErrors,
            inMissedRun: false,
        };
        this.previousStreamId = this.streamId;
        this.awaitingStream = true;
        this.lastCurrent = undefined;
        return super.ppkAverageStart();
    }
}

export default SerialDevice;
