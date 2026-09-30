/*
 * Copyright (c) 2015 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-4-Clause
 */

import { formatDataForExport } from '../exportChartAction';

const buffer = [7, 8, 9, 10];
// volts; the third sample has no voltage recorded
const voltage = [2.0, 3.0, NaN, 1.5];
const bitsData = [0xaaaa, 0x5555, 0x6566];
const startingPoint = 2;

jest.mock('../../features/recovery/SessionsListFileHandler', () => ({
    ReadSessions: jest.fn(() => []),
    WriteSessions: jest.fn(),
}));

// Timestamps are at the default 100 kHz: 10 us per sample, so index 2 is
// 0.02 ms. Selection columns: [timestamp, current, voltage, power, bits,
// bitsSeparated].
describe('formatData', () => {
    it('should contain only current values', () => {
        const selection = [false, true, false, false, false, false];
        const content = formatDataForExport(
            startingPoint,
            buffer,
            voltage,
            bitsData,
            selection,
        );
        expect(content).toMatch(/^7\.000\s/);
        expect(content).toMatch(/\s8\.000\s/);
        expect(content).toMatch(/\s9\.000\s/);
    });

    it('should contain only timestamp and current values', () => {
        const selection = [true, true, false, false, false, false];
        const content = formatDataForExport(
            startingPoint,
            buffer,
            voltage,
            bitsData,
            selection,
        );
        expect(content).toMatch(/0\.02,7\.000\s/);
        expect(content).toMatch(/0\.03,8\.000\s/);
        expect(content).toMatch(/0\.04,9\.000\s/);
    });

    it('should contain voltage and power, empty where voltage is missing', () => {
        const selection = [false, true, true, true, false, false];
        const content = formatDataForExport(
            startingPoint,
            buffer,
            voltage,
            bitsData,
            selection,
        );
        // 7 uA x 2 V = 14 uW
        expect(content).toMatch(/^7\.000,2\.0000,14\.000\s/);
        expect(content).toMatch(/\s8\.000,3\.0000,24\.000\s/);
        expect(content).toMatch(/\s9\.000,,\s/);
    });

    it('should contain all data', () => {
        const selection = [true, true, true, true, true, true];
        const content = formatDataForExport(
            startingPoint,
            buffer,
            voltage,
            bitsData,
            selection,
        );
        expect(content).toMatch(
            /0\.02,7\.000,2\.0000,14\.000,11111111,1,1,1,1,1,1,1,1/,
        );
        expect(content).toMatch(
            /0\.03,8\.000,3\.0000,24\.000,00000000,0,0,0,0,0,0,0,0\s/,
        );
        expect(content).toMatch(/0\.04,9\.000,,,10100010,1,0,1,0,0,0,1,0\s/);
    });
});
