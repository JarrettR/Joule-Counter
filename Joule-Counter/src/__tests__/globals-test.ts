/*
 * Copyright (c) 2022 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-4-Clause
 */

import { DataManager, timestampToIndex } from '../globals';
import { FoldingBuffer } from '../utils/foldingBuffer';

jest.mock('../features/recovery/SessionsListFileHandler', () => ({
    ReadSessions: jest.fn(() => []),
}));

beforeEach(() => {
    DataManager().reset();
});

describe('timestampToIndex', () => {
    it('should return zero if timestamps are zero', () => {
        expect(timestampToIndex(0)).toBe(0);
    });

    it('should return index equal to options.index if argument is options.timestamp', () => {
        DataManager().setSamplesPerSecond(1);
        expect(timestampToIndex(30 * 1e6)).toBe(30);
    });
});

describe('minimap folding', () => {
    it('keeps track of missing samples through folds', () => {
        const minimap = new FoldingBuffer();
        // 20 000 samples fold twice: 4 samples per element in the end
        for (let i = 0; i < 20_000; i += 1) {
            const missing = i >= 7_000 && i < 7_010;
            minimap.addData(missing ? NaN : 5, i * 10);
        }

        const counts = (minimap.data.missing ?? []).slice(
            0,
            minimap.data.length,
        );
        expect(counts.reduce((a, b) => a + b, 0)).toBe(10);
        expect(counts.slice(1750, 1753)).toEqual([4, 4, 2]);

        const flagged = minimap.getData().filter(p => p.missing);
        expect(flagged).toHaveLength(6); // min and max of three elements
    });

    it('reads minimaps saved before missing samples were counted', () => {
        const minimap = new FoldingBuffer();
        minimap.addData(5, 0);
        delete minimap.data.missing;
        minimap.addData(NaN, 10);

        expect(minimap.getData().some(p => p.missing)).toBe(false);
    });
});
