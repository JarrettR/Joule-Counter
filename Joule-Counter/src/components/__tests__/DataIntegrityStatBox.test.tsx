/*
 * Copyright (c) 2026 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-4-Clause
 */

import React from 'react';

import { setDataIntegrity } from '../../slices/appSlice';
import { setLatestDataTimestamp } from '../../slices/chartSlice';
import { render, screen } from '../../utils/testUtils';
import { DataIntegrityStatBox } from '../Chart/Chart';

jest.mock('../../features/recovery/SessionsListFileHandler', () => ({
    ReadSessions: jest.fn(() => []),
    WriteSessions: jest.fn(),
}));

const clean = {
    lostSamples: 0,
    gaps: 0,
    kitOverflows: 0,
    crcErrors: 0,
    samplingTimeUs: 10,
};

const cell = (label: string) => screen.getByText(label).parentElement;

describe('DataIntegrityStatBox', () => {
    it('waits for a recording', () => {
        render(<DataIntegrityStatBox />);

        expect(screen.getByText('Shown once sampling starts')).toBeDefined();
    });

    it('says when the data on screen has no record of its losses', () => {
        render(<DataIntegrityStatBox />, [setLatestDataTimestamp(1000)]);

        expect(screen.getByText(/Not recorded for this data/)).toBeDefined();
    });

    it('shows a clean stream without alarm', () => {
        render(<DataIntegrityStatBox />, [setDataIntegrity(clean)]);

        expect(screen.getByText('none')).toBeDefined();
        ['lost data', 'gaps', 'kit buffer overflows', 'CRC errors'].forEach(
            label => expect(cell(label)?.className).not.toMatch(/tw-text-red/),
        );
    });

    it('shows losses in red, with the time they cover', () => {
        render(<DataIntegrityStatBox />, [
            setDataIntegrity({
                ...clean,
                lostSamples: 1234,
                gaps: 3,
                kitOverflows: 1,
            }),
        ]);

        // 1234 samples at 10 µs
        expect(cell('lost data')?.textContent).toMatch(/12\.34\s*ms/);
        expect(cell('lost samples')?.textContent).toMatch(/1,234/);
        expect(cell('lost data')?.className).toMatch(/tw-text-red/);
        expect(cell('gaps')?.className).toMatch(/tw-text-red/);
        expect(cell('kit buffer overflows')?.className).toMatch(/tw-text-red/);
        expect(cell('CRC errors')?.className).not.toMatch(/tw-text-red/);
    });
});
