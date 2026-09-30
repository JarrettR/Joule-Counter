/*
 * Copyright (c) 2025 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-4-Clause
 */

/*
 * Drives the accumulator the way live mode does: the window slides over a
 * growing record and the cached result is merged with fresh edge data every
 * frame. Every frame must come back with the same number of points; a frame
 * that loses the trace is what the user sees as a flicker.
 */

import {
    frameSize,
    indexToTimestamp,
    timestampToIndex,
} from '../../../../globals';
import dataAccumulatorInitialiser, {
    calcStats,
    type RangeStats,
    resetCache,
} from '../dataAccumulator';

// The app's default rate, so the accumulator's own time helpers agree with
// the record below.
const SAMPLES_PER_SECOND = 100_000;
const TOTAL_SECONDS = 25;
const record = Buffer.alloc(TOTAL_SECONDS * SAMPLES_PER_SECOND * frameSize);
// Samples appended so far; grows during the run like a live session.
let latestIndex = 0;

jest.mock('../../../../features/recovery/SessionsListFileHandler', () => ({
    ReadSessions: jest.fn(() => []),
    WriteSessions: jest.fn(),
    AddSession: jest.fn(),
    RemoveSessionByFilePath: jest.fn(),
    ClearSessions: jest.fn(),
    SessionFlag: { NotRecovered: 0, Recovered: 1, PPK2Loaded: 2 },
}));

jest.mock('../../../../globals', () => {
    const actual = jest.requireActual('../../../../globals');
    return {
        ...actual,
        DataManager: () => ({
            getSamplingTime: () => 1e6 / SAMPLES_PER_SECOND,
            getSamplesPerSecond: () => SAMPLES_PER_SECOND,
            getTimestamp: () =>
                actual.indexToTimestamp(latestIndex - 1, SAMPLES_PER_SECOND),
            getTotalSavedRecords: () => latestIndex,
            getNumberOfSamplesInWindow: (windowDuration: number) =>
                actual.timestampToIndex(windowDuration, SAMPLES_PER_SECOND),
            getData: (buffer: Buffer, fromTime: number, toTime: number) => {
                const first = actual.timestampToIndex(
                    fromTime,
                    SAMPLES_PER_SECOND,
                );
                const last = Math.min(
                    actual.timestampToIndex(toTime, SAMPLES_PER_SECOND),
                    latestIndex - 1,
                );
                const bytes = Math.max(
                    0,
                    (last - first + 1) * actual.frameSize,
                );
                record.copy(
                    buffer,
                    0,
                    first * actual.frameSize,
                    first * actual.frameSize + bytes,
                );
                return Promise.resolve(new actual.FileData(buffer, bytes));
            },
        }),
    };
});

const writeSample = (index: number, current: number, voltage: number) => {
    const off = index * frameSize;
    record.writeFloatLE(current, off);
    record.writeFloatLE(voltage, off + 4);
    record.writeUInt16BE(0xaaaa, off + 8);
};

describe('live-mode accumulation', () => {
    beforeAll(() => {
        // 9 uA baseline with a 1 mA pulse every 71.7 ms, at 2.33 V.
        for (let i = 0; i < TOTAL_SECONDS * SAMPLES_PER_SECOND; i += 1) {
            const inPulse = i % 3585 < 22;
            writeSample(i, inPulse ? 1000 : 9, 2.33);
        }
    });

    it('never loses the trace between frames', async () => {
        const acc = dataAccumulatorInitialiser();
        const windowDuration = 10e6; // µs
        const frameStep = Math.round(SAMPLES_PER_SECOND / 30); // ~33 ms of new data per frame
        const anomalies: string[] = [];
        let prevPoints: number | undefined;

        // Deterministic jitter: USB delivers 512-sample blocks, so frames see
        // anywhere from nothing new to a few blocks.
        let seed = 12345;
        const rand = () => {
            seed = (seed * 1103515245 + 12345) % 2 ** 31;
            return seed / 2 ** 31;
        };

        latestIndex = 12 * SAMPLES_PER_SECOND; // start with 12 s recorded
        while (
            latestIndex + 3 * frameStep <
            TOTAL_SECONDS * SAMPLES_PER_SECOND
        ) {
            latestIndex += 512 * Math.floor(rand() * 7); // 0..6 blocks
            const end = indexToTimestamp(latestIndex - 1, SAMPLES_PER_SECOND);
            const begin = Math.max(0, end - windowDuration);

            // eslint-disable-next-line no-await-in-loop
            const result = await acc.process(
                begin,
                end,
                [],
                1000,
                windowDuration,
            );

            const points = result.ampereLineData.filter(
                p => p && p.x !== undefined && p.y != null,
            ).length;
            const powerPoints = result.powerLine.filter(
                p => p && p.x !== undefined && p.count > 0,
            ).length;
            const xs = result.ampereLineData
                .filter(p => p && p.x !== undefined)
                .map(p => p.x as number);
            const span = xs.length ? Math.max(...xs) - Math.min(...xs) : 0;

            if (
                prevPoints !== undefined &&
                (points < prevPoints * 0.9 || powerPoints < points / 2 - 5)
            ) {
                anomalies.push(
                    `at ${(end / 1e6).toFixed(2)} s: ${points} current points (was ${prevPoints}), ${powerPoints} power points, span ${(span / 1e6).toFixed(2)} s, ${timestampToIndex(span, SAMPLES_PER_SECOND)} samples`,
                );
            }
            prevPoints = points;
        }

        expect(anomalies).toEqual([]);
    }, 120_000);
});

describe('missing samples', () => {
    const SAMPLES = 10_000;
    const GAP_FIRST = 1050;
    const GAP_LAST = 1149; // 100 samples, straddling two 100-sample groups

    beforeAll(() => {
        for (let i = 0; i < SAMPLES; i += 1) {
            const missing = i >= GAP_FIRST && i <= GAP_LAST;
            writeSample(i, missing ? NaN : 5, missing ? NaN : 3);
        }
        latestIndex = SAMPLES;
    });

    beforeEach(() => resetCache());

    const at = (index: number) => indexToTimestamp(index, SAMPLES_PER_SECOND);

    it('marks every missing sample at full resolution', async () => {
        const begin = at(1000);
        const end = at(1199);
        const result = await dataAccumulatorInitialiser().process(
            begin,
            end,
            [],
            1000,
            end - begin,
        );

        const flagged = result.ampereLineData
            .filter(p => p.missing)
            .map(p => timestampToIndex(p.x as number, SAMPLES_PER_SECOND));
        expect(flagged).toHaveLength(GAP_LAST - GAP_FIRST + 1);
        expect(flagged[0]).toBe(GAP_FIRST);
        expect(flagged[flagged.length - 1]).toBe(GAP_LAST);
        expect(
            result.averageLine.reduce((n, p) => n + (p.missing ?? 0), 0),
        ).toBe(GAP_LAST - GAP_FIRST + 1);
        // the power and voltage lines keep the gap instead of bridging it
        expect(result.powerLine.filter(p => p.missing)).toHaveLength(
            GAP_LAST - GAP_FIRST + 1,
        );
        expect(result.voltageLine.filter(p => p.missing)).toHaveLength(
            GAP_LAST - GAP_FIRST + 1,
        );
    });

    it('flags each group a gap touches when zoomed out', async () => {
        const result = await dataAccumulatorInitialiser().process(
            0,
            at(SAMPLES - 1),
            [],
            100,
            at(SAMPLES - 1),
        );

        // 100 samples a group: the gap is the second half of group 10 and
        // the first half of group 11
        const groups = result.averageLine
            .map((p, g) => ({ g, missing: p.missing ?? 0 }))
            .filter(p => p.missing > 0);
        expect(groups).toEqual([
            { g: 10, missing: 50 },
            { g: 11, missing: 50 },
        ]);
        const flaggedPoints = result.ampereLineData.filter(p => p.missing);
        expect(flaggedPoints).toHaveLength(4); // min and max of each group
        // both groups still have samples, so they keep a value
        expect(flaggedPoints.every(p => p.y === 5000)).toBe(true);
        expect(result.powerLine.filter(p => p.missing)).toHaveLength(2);
    });

    it('counts the gap in the statistics and fills it with the mean', async () => {
        const stats = await new Promise<RangeStats>(resolve => {
            calcStats(resolve, 0, at(SAMPLES - 1));
        });

        expect(stats.missing).toBe(GAP_LAST - GAP_FIRST + 1);
        expect(stats.average).toBeCloseTo(5, 6);
        // 5 µA × 3 V = 15 µW over the whole 0.1 s, gap included
        expect(stats.delta).toBeCloseTo(SAMPLES * 10, 6);
        expect(stats.energy).toBeCloseTo(15 * 0.1, 6);
    });
});
