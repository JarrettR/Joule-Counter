/*
 * Copyright (c) 2015 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-4-Clause
 */
/* eslint-disable @typescript-eslint/no-non-null-assertion -- conservative refactoring, TODO: remove this line */

import React from 'react';
import { useSelector } from 'react-redux';
import { unit } from 'mathjs';

import { DataManager } from '../../globals';
import { getTraces } from '../../slices/chartSlice';
import { formatDurationHTML } from '../../utils/duration';
import { Value, ValueRaw } from './StatBoxHelpers';

interface StatBoxProperties {
    average?: number | null;
    max?: number | null;
    delta?: number | null;
    /** µJ over the window; NaN hides the value */
    energy?: number | null;
    /** mean DUT voltage, V */
    voltage?: number | null;
    /** samples in the window that never arrived */
    missing?: number;
}

/* Time, charge and energy are always shown; the per-quantity figures follow
 * the Display options so the row matches what the chart is drawing.
 */
export default ({
    average = null,
    max = null,
    delta = null,
    energy = null,
    voltage = null,
    missing = 0,
}: StatBoxProperties) => {
    const traces = useSelector(getTraces);
    const seconds = (delta || 1) / 1e6;
    const meanPower =
        energy != null && !Number.isNaN(energy) ? energy / seconds : NaN;

    return (
        <div className="tw-preflight tw-flex tw-w-80 tw-grow tw-flex-col tw-gap-1 tw-text-center">
            <div className="tw-flex tw-h-3.5 tw-items-center tw-justify-between">
                <h2 className="tw-inline tw-text-[10px] tw-uppercase">
                    Window
                </h2>
            </div>
            <div className="tw-flex tw-flex-row tw-gap-[1px] tw-border tw-border-solid tw-border-gray-200 tw-bg-gray-200">
                {traces.current && (
                    <>
                        <Value
                            label="avg current"
                            u={unit(average!, 'uA')}
                            white
                        />
                        <Value
                            label="max current"
                            u={unit(max || 0, 'uA')}
                            white
                        />
                    </>
                )}
                {traces.voltage && (
                    <Value
                        label="avg voltage"
                        u={unit(voltage ?? NaN, 'V')}
                        white
                    />
                )}
                {traces.power && (
                    <Value label="avg power" u={unit(meanPower, 'uW')} white />
                )}
                <ValueRaw
                    label="time"
                    value={formatDurationHTML(delta ?? 0)}
                    white
                />
                <Value
                    white
                    label="charge"
                    u={unit(average! * seconds, 'uC')}
                />
                <Value white label="energy" u={unit(energy ?? NaN, 'uJ')} />
                {missing > 0 && (
                    <ValueRaw
                        label="lost data"
                        value={formatDurationHTML(
                            missing * DataManager().getSamplingTime(),
                        )}
                        alert
                        white
                        title="Samples in this range never arrived from the kit; charge and energy count them at the mean of the rest."
                    />
                )}
            </div>
        </div>
    );
};
