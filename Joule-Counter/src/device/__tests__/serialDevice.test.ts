/*
 * Copyright (c) 2015 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-4-Clause
 */

/* eslint-disable @typescript-eslint/no-require-imports, global-require */

import EventEmitter from 'events';

const mockChild = Object.assign(new EventEmitter(), {
    send: jest.fn(),
    kill: jest.fn(),
    pid: 12345,
    connected: true,
    disconnect: jest.fn(),
    unref: jest.fn(),
    ref: jest.fn(),
    killed: false,
    exitCode: null,
    signalCode: null,
    channel: undefined,
    stdio: [null, null, null, null],
    stdin: null,
    stdout: null,
    stderr: null,
});

jest.mock('@nordicsemiconductor/pc-nrfconnect-shared', () => ({
    getAppDir: jest.fn(() => '/mock/app'),
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

jest.mock(
    '@nordicsemiconductor/pc-nrfconnect-shared/nrfutil/device/common',
    () => ({}),
);

jest.mock('child_process', () => ({
    fork: jest.fn(() => mockChild),
}));

const originalPlatform = process.platform;

describe('SerialDevice', () => {
    const mockDevice = {
        serialPorts: [{ comName: '/dev/tty.test' }],
    };
    const mockCallback = jest.fn();

    beforeEach(() => {
        jest.clearAllMocks();
        mockChild.removeAllListeners();
    });

    afterAll(() => {
        Object.defineProperty(process, 'platform', {
            value: originalPlatform,
        });
    });

    function loadSerialDevice() {
        const { fork } = require('child_process');
        const { default: SerialDevice } = require('../serialDevice');
        const { logger } = require('@nordicsemiconductor/pc-nrfconnect-shared');
        return { SerialDevice, fork, logger };
    }

    test('uses serialDevice.darwin.js worker on macOS', () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        jest.resetModules();

        const { SerialDevice, fork } = loadSerialDevice();
        const device = new SerialDevice(mockDevice, mockCallback);

        expect(device).toBeDefined();
        expect(fork).toHaveBeenCalledWith(
            expect.stringContaining('serialDevice.darwin.js'),
            { serialization: 'advanced' },
        );
    });

    test('uses serialDevice.js worker on Linux', () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        jest.resetModules();

        const { SerialDevice, fork } = loadSerialDevice();
        const device = new SerialDevice(mockDevice, mockCallback);

        expect(device).toBeDefined();
        expect(fork).toHaveBeenCalledWith(
            expect.stringContaining('serialDevice.js'),
            { serialization: 'advanced' },
        );
        expect(fork).not.toHaveBeenCalledWith(
            expect.stringContaining('darwin'),
            expect.anything(),
        );
    });

    test('uses serialDevice.js worker on Windows', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        jest.resetModules();

        const { SerialDevice, fork } = loadSerialDevice();
        const device = new SerialDevice(mockDevice, mockCallback);

        expect(device).toBeDefined();
        expect(fork).toHaveBeenCalledWith(
            expect.stringContaining('serialDevice.js'),
            { serialization: 'advanced' },
        );
        expect(fork).not.toHaveBeenCalledWith(
            expect.stringContaining('darwin'),
            expect.anything(),
        );
    });

    test('logs error messages from worker via logger.error', () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        jest.resetModules();

        const { SerialDevice, logger } = loadSerialDevice();
        const device = new SerialDevice(mockDevice, mockCallback);
        device.parser = jest.fn();

        mockChild.emit('message', { error: 'PPK command failed' });

        expect(logger.error).toHaveBeenCalledWith('PPK command failed');
    });

    test('passes buffer data to parser', () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        jest.resetModules();

        const { SerialDevice } = loadSerialDevice();
        const device = new SerialDevice(mockDevice, mockCallback);
        const parserMock = jest.fn();
        device.parser = parserMock;

        const testData = [1, 2, 3, 4];
        mockChild.emit('message', { type: 'Buffer', data: testData });

        expect(parserMock).toHaveBeenCalledWith(Buffer.from(testData));
    });

    test('passes structured-clone buffers to parser', () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        jest.resetModules();

        const { SerialDevice } = loadSerialDevice();
        const device = new SerialDevice(mockDevice, mockCallback);
        const parserMock = jest.fn();
        device.parser = parserMock;

        mockChild.emit('message', new Uint8Array([5, 6, 7]));

        expect(parserMock).toHaveBeenCalledWith(Buffer.from([5, 6, 7]));
    });
});

interface TestSample {
    current?: number;
    range?: number;
    voltage?: number;
    logic?: number;
}

const FIELD_BITS = [11, 3, 11, 8];

// Encodes a block the way firmware/src/sampling.c and protocol.c do: each
// field as its offset from the block minimum, in the bits its spread needs.
const makeBlock = (
    crc32: (d: Uint8Array, s: number, e: number, seed?: number) => number,
    { first = 0, stream = 1, flags = 0, samples = [] as TestSample[] },
) => {
    /* eslint-disable no-bitwise */
    const rows = samples.map(
        ({ current = 0, range = 0, voltage = 0, logic = 0 }) => [
            current,
            range,
            voltage,
            logic,
        ],
    );
    const bases = FIELD_BITS.map((_, f) =>
        rows.length ? Math.min(...rows.map(r => r[f])) : 0,
    );
    const widths = FIELD_BITS.map((_, f) => {
        const spread = rows.length
            ? Math.max(...rows.map(r => r[f])) - bases[f]
            : 0;
        return spread ? 32 - Math.clz32(spread) : 0;
    });
    const bits = widths.reduce((a, b) => a + b, 0);
    const words = new Uint32Array(Math.ceil((rows.length * bits) / 32));
    let pos = 0;
    rows.forEach(row =>
        row.forEach((value, f) => {
            for (let b = 0; b < widths[f]; b += 1, pos += 1) {
                words[pos >>> 5] |=
                    (((value - bases[f]) >>> b) & 1) << (pos & 31);
            }
        }),
    );

    const buf = Buffer.alloc(24 + 4 * words.length);
    buf.write('JC', 0, 'latin1');
    buf[2] = 1;
    buf[3] = flags;
    buf.writeUInt32LE(first, 4);
    buf.writeUInt16LE(rows.length, 8);
    buf[10] = stream;
    buf.writeUInt16LE(bases[0], 12);
    buf.writeUInt16LE(bases[2], 14);
    buf[16] = bases[1];
    buf[17] = bases[3];
    buf[18] = widths[0] | (widths[2] << 4);
    buf[19] = widths[1] | (widths[3] << 4);
    words.forEach((w, j) => buf.writeUInt32LE(w >>> 0, 24 + 4 * j));
    buf.writeUInt32LE(crc32(buf, 24, buf.length, crc32(buf, 0, 20)), 20);
    return buf;
    /* eslint-enable no-bitwise */
};

// firmware/src/sampling.c sampling_test_block(): the pseudo-random samples
// of a pack-mode link test block, seeded with its first index + 1.
const testBlockSamples = (seed: number) => {
    /* eslint-disable no-bitwise */
    let state = seed || 1;
    const draw = () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        return state;
    };
    const masks: number[] = [];
    const bases: number[] = [];
    FIELD_BITS.forEach(full => {
        masks.push((1 << draw() % (full + 1)) - 1);
        bases.push(draw() & ((1 << full) - 1));
    });
    return Array.from({ length: 512 }, () =>
        masks.map((mask, f) => ((bases[f] & ~mask) | (draw() & mask)) >>> 0),
    );
    /* eslint-enable no-bitwise */
};

describe('block stream', () => {
    const mockDevice = {
        serialPorts: [{ comName: '/dev/tty.test' }],
    };

    beforeEach(() => {
        mockChild.removeAllListeners();
    });

    function load() {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        jest.resetModules();
        const mod = require('../serialDevice');
        const { logger } = require('@nordicsemiconductor/pc-nrfconnect-shared');
        const samples: Record<string, unknown>[] = [];
        const SerialDevice = mod.default;
        const device = new SerialDevice(mockDevice, (v: object) =>
            samples.push(v as Record<string, unknown>),
        );
        return { mod, device, samples, logger };
    }

    const voltsOf = (field: number) => ((field * 4 * 1800) / 8192 / 1000) * 5;

    test.each(['pack-test-narrow.hex', 'pack-test-wide.hex'])(
        'unpacks blocks packed by the firmware (%s)',
        name => {
            const { mod } = load();
            const fs = require('fs');
            const raw = Buffer.from(
                fs
                    .readFileSync(`${__dirname}/fixtures/${name}`, 'latin1')
                    .trim(),
                'hex',
            );
            const blocks: { first: number }[] = [];
            mod.createBlockParser().feed(raw, (b: { first: number }) =>
                blocks.push(b),
            );

            expect(blocks).toHaveLength(1);
            const fields = mod.unpackBlock(blocks[0]);
            const samples = testBlockSamples(blocks[0].first + 1);
            samples.forEach((sample, k) =>
                sample.forEach((value, f) => {
                    expect(fields[f][k]).toBe(value);
                }),
            );
        },
    );

    test('crc32 matches zlib', () => {
        const { mod } = load();
        const check = Buffer.from('123456789', 'latin1');
        expect(mod.crc32(check, 0, check.length)).toBe(0xcbf43926);
    });

    test('decodes samples, logic D7 and the voltage field', () => {
        const { mod, device, samples } = load();
        device.ppkAverageStart();
        const block = makeBlock(mod.crc32, {
            samples: [
                { current: 100, voltage: 750, logic: 0x81 },
                { current: 2047, range: 1, voltage: 2047, logic: 0x7f },
            ],
        });

        device.parseMeasurementData(block);

        expect(samples).toHaveLength(2);
        expect(samples[0].bits).toBe(0x81);
        expect(samples[1].bits).toBe(0x7f);
        expect(samples[0].voltage).toBeCloseTo(voltsOf(750), 9);
        expect(samples[1].voltage).toBeCloseTo(voltsOf(2047), 9);
        // Uncalibrated defaults: R0 1031.64, unity gains, no offset.
        const i = (400 * (1.8 / 163840)) / 1031.64;
        expect(samples[0].value).toBeCloseTo(i * (i + 1) * 1e6, 6);
    });

    test('reassembles blocks split across reads and skips garbage', () => {
        const { mod, device, samples } = load();
        device.ppkAverageStart();
        const a = makeBlock(mod.crc32, {
            first: 0,
            samples: Array(40).fill({ current: 5 }),
        });
        const b = makeBlock(mod.crc32, {
            first: 40,
            samples: Array(3).fill({ current: 6 }),
        });
        const stream = Buffer.concat([Buffer.from('JCxx END'), a, b]);

        for (let i = 0; i < stream.length; i += 7) {
            device.parseMeasurementData(stream.subarray(i, i + 7));
        }

        expect(samples).toHaveLength(43);
        expect(samples.every(s => s.value !== undefined)).toBe(true);
    });

    test('drops a corrupted block and resynchronises', () => {
        const { mod, device, samples } = load();
        device.ppkAverageStart();
        const bad = makeBlock(mod.crc32, {
            first: 0,
            samples: [{ current: 1 }, { current: 1 }],
        });
        bad[20] = 0xff - bad[20];
        const good = makeBlock(mod.crc32, {
            first: 2,
            samples: [{ current: 1 }],
        });

        device.parseMeasurementData(Buffer.concat([bad, good]));

        // The two lost samples keep their slots as empty samples.
        expect(samples).toHaveLength(3);
        expect(samples[0]).toEqual({});
        expect(samples[1]).toEqual({});
        expect(samples[2].value).toBeDefined();
    });

    test('fills gaps exactly and reports the loss', () => {
        const { mod, device, samples, logger } = load();
        device.ppkAverageStart();

        device.parseMeasurementData(
            Buffer.concat([
                makeBlock(mod.crc32, { first: 0, samples: [{}, {}] }),
                makeBlock(mod.crc32, {
                    first: 1002,
                    flags: mod.BlockFlag.Overflow,
                    samples: [{}],
                }),
            ]),
        );

        expect(samples).toHaveLength(1003);
        expect(samples.slice(2, 1002).every(s => s.value === undefined)).toBe(
            true,
        );
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('not read out fast enough'),
        );
    });

    test('ignores the tail of the previous stream after a restart', () => {
        const { mod, device, samples } = load();
        device.ppkAverageStart();
        device.parseMeasurementData(
            makeBlock(mod.crc32, { stream: 4, samples: [{}] }),
        );
        device.ppkAverageStart();

        device.parseMeasurementData(
            Buffer.concat([
                makeBlock(mod.crc32, { stream: 4, first: 1, samples: [{}] }),
                makeBlock(mod.crc32, {
                    stream: 5,
                    first: 0,
                    samples: [{}, {}],
                }),
            ]),
        );

        expect(samples).toHaveLength(3);
    });

    test('holds the current through switching samples and blanks missing ones', () => {
        const { mod, device, samples } = load();
        device.ppkAverageStart();

        device.parseMeasurementData(
            makeBlock(mod.crc32, {
                samples: [
                    { current: 300, voltage: 700 },
                    { current: 12, range: 7, voltage: 701, logic: 3 },
                    { range: 6 },
                ],
            }),
        );

        expect(samples[1].value).toBe(samples[0].value);
        expect(samples[1].voltage).toBeCloseTo(voltsOf(701), 9);
        expect(samples[1].bits).toBe(3);
        expect(samples[2]).toEqual({});
    });

    test('counts what went missing, and why', () => {
        const { mod, device } = load();
        device.ppkAverageStart();
        // one zero-width sample: the block is its 24-byte header
        const corrupt = makeBlock(mod.crc32, { first: 3, samples: [{}] });
        corrupt[4] = 0xff - corrupt[4];

        device.parseMeasurementData(
            Buffer.concat([
                makeBlock(mod.crc32, {
                    first: 0,
                    samples: [{}, { range: 6 }, { range: 6 }],
                }),
                corrupt,
                makeBlock(mod.crc32, { first: 4, samples: [{}] }),
                makeBlock(mod.crc32, {
                    first: 10,
                    flags: mod.BlockFlag.Overflow,
                    samples: [{ range: 6 }, {}],
                }),
            ]),
        );

        expect(device.getStreamIntegrity()).toEqual({
            // two missed conversions, the corrupt block's sample, five
            // dropped by the kit, one more missed conversion
            lostSamples: 2 + 1 + 5 + 1,
            gaps: 4,
            kitOverflows: 1,
            crcErrors: 1,
            samplingTimeUs: 10,
        });

        device.ppkAverageStart();
        expect(device.getStreamIntegrity()).toEqual({
            lostSamples: 0,
            gaps: 0,
            kitOverflows: 0,
            crcErrors: 0,
            samplingTimeUs: 10,
        });
    });

    test('ignores link test blocks', () => {
        const { mod, device, samples } = load();
        device.ppkAverageStart();

        device.parseMeasurementData(
            makeBlock(mod.crc32, {
                flags: mod.BlockFlag.Test,
                samples: [{}, {}],
            }),
        );

        expect(samples).toHaveLength(0);
    });

    test('reads metadata that arrives behind stray stream bytes', async () => {
        const { mod, device } = load();
        const meta = device.getMetadata();
        device.parser(
            Buffer.concat([
                makeBlock(mod.crc32, { samples: [{}] }),
                Buffer.from(
                    'Calibrated: 1\nR0: 1000.5\nVDD: 3000\nSampleRate: 100000\nBlockFormat: 1\nEND\n',
                    'latin1',
                ),
            ]),
        );

        const parsed = device.parseMeta(await meta);

        expect(parsed.r0).toBe(1000.5);
        expect(device.adcSamplingTimeUs).toBe(10);
    });

    test('refuses a stream format it cannot read', () => {
        const { device } = load();
        expect(() => device.parseMeta({ samplerate: 50000 })).toThrow(
            /Reprogram the kit/,
        );
    });
});
