/*
 * Copyright (c) 2015 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-4-Clause
 */

import React from 'react';
import { Line } from 'react-chartjs-2';
import type {
    ChartJSOrUndefined,
    ForwardedRef,
} from 'react-chartjs-2/dist/types';
import { useDispatch, useSelector } from 'react-redux';
import {
    classNames,
    colors,
    Spinner,
} from '@nordicsemiconductor/pc-nrfconnect-shared';
import {
    type Chart,
    type ChartConfiguration,
    type ChartData,
    type ChartOptions,
} from 'chart.js';
import { unit } from 'mathjs';

import { DataManager } from '../../globals';
import { isFileLoaded, isSamplingRunning } from '../../slices/appSlice';
import {
    getChartYAxisRange,
    getCursorRange,
    getTraces,
    getWindowDuration,
    isLiveMode,
    isTimestampsVisible,
    showSystemTime,
} from '../../slices/chartSlice';
import {
    getTriggerOrigin,
    getTriggerValue,
    setTriggerLevel,
} from '../../slices/triggerSlice';
import { isScopePane } from '../../utils/panes';
import { type CursorData } from './Chart';
import { type AmpereState } from './data/dataTypes';
import crossHairPlugin from './plugins/chart.crossHair';
import dragSelectPlugin, { type DragSelect } from './plugins/chart.dragSelect';
import triggerLevelPlugin from './plugins/chart.triggerLevel';
import triggerOriginPlugin from './plugins/chart.triggerOrigin';
import zoomPanPlugin, { type ZoomPan } from './plugins/chart.zoomPan';
import { missingDataPlugin, missingSegment } from './plugins/utility';

const yAxisWidth = 64;
const rightMargin = 32;
const dataColor = colors.nordicBlue;

interface Cursor {
    cursorBegin?: null | number;
    cursorEnd?: null | number;
}

export interface CrossHairValue {
    /** points sorted by x; each covers the time up to the next one */
    data: AmpereState[];
    scaleId: string;
    format: (value: number) => string;
    color: string;
    visible: boolean;
}

export interface AmpereChartOptions extends ChartOptions<'line'> {
    formatX: (usecs: number) => string | string[] | undefined;
    /** Traces the crosshair reads out at the cursor time, top to bottom */
    crossHairValues?: CrossHairValue[];
    snapping: boolean;
    live: boolean;
    windowDuration: number;
    cursor: Cursor;
    id?: string;
    triggerHandleVisible: boolean;
    triggerOrigin?: number;
    updateTriggerLevel: (level: number) => void;
    triggerLevel?: null | number;
}

interface AmpereChartConfigurations extends ChartConfiguration<'line'> {
    options: AmpereChartOptions;
}

export interface AmpereChartJS extends Chart<'line'> {
    options: AmpereChartOptions;
    dragSelect?: DragSelect;
    zoomPan?: ZoomPan;
    sampleFrequency?: number;
    triggerLine: Pick<AmpereState, 'y'>;
    config: AmpereChartConfigurations;
}

interface AmpereChartProperties {
    setNumberOfPixelsInWindow: (length: number) => void;
    setChartAreaWidth: (width: number) => void;
    numberOfSamplesPerPixel: number;
    chartRef: React.MutableRefObject<null | AmpereChartJS>;
    cursorData: CursorData;
    lineData: AmpereState[];
    /** mean current per rendered point, nA */
    currentMeanLineData: AmpereState[];
    /** mean power per rendered point, \u00B5W */
    powerLineData: AmpereState[];
    /** mean DUT voltage per rendered point, V */
    voltageLineData: AmpereState[];
    processing: boolean;
    processingMessage?: string;
    processingPercent?: number;
}

const formatCurrent = (nA: number) =>
    typeof nA === 'number'
        ? unit(nA, 'nA')
              .format({ notation: 'auto', precision: 4 })
              .replace('u', '\u00B5')
        : (undefined as never);

const formatPower = (uW: number) =>
    typeof uW === 'number'
        ? unit(uW, 'uW')
              .format({ notation: 'auto', precision: 4 })
              .replace('u', '\u00B5')
        : (undefined as never);

const formatVoltage = (v: number) =>
    typeof v === 'number'
        ? unit(v, 'V')
              .format({ notation: 'auto', precision: 4 })
              .replace('u', 'µ')
        : (undefined as never);

const powerColor = colors.orange700;
const voltageColor = colors.deepPurple;

const padL = (nr: number, len = 2, chr = `0`) => `${nr}`.padStart(len, chr);

const timestampToLabel = (usecs: number, useSystemTime: boolean) => {
    const microseconds = Math.abs(usecs);

    const systemStartTime = useSystemTime
        ? DataManager().getStartSystemTime()
        : null;

    if (systemStartTime != null) {
        const milliSeconds = Math.trunc(microseconds / 1000);
        const time = new Date(milliSeconds + systemStartTime);
        const subsecond =
            Number(
                ((microseconds + time.getMilliseconds() * 1000) / 1e3) % 1e3,
            ) ?? 0;

        return [
            `${time.getFullYear()}-${padL(time.getMonth() + 1)}-${padL(
                time.getDate(),
            )} ${padL(time.getHours())}:${padL(time.getMinutes())}:${padL(
                time.getSeconds(),
            )}`,
            `${subsecond.toFixed(3)}`.padStart(7, '0'),
        ];
    }

    const subsecond = Number((microseconds / 1e3) % 1e3) ?? 0;
    const sign = usecs < 0 ? '-' : '';

    const date = new Date(microseconds / 1e3);
    const d = Math.trunc(usecs / 86400000000);
    const h = (date.getUTCHours() + d * 24).toString().padStart(2, '0');
    const m = date.getUTCMinutes().toString().padStart(2, '0');
    const s = date.getUTCSeconds().toString().padStart(2, '0');

    const time = `${sign}${h}:${m}:${s}`;

    return [time, `${subsecond.toFixed(3)}`.padStart(7, '0')];
};

export default ({
    setNumberOfPixelsInWindow,
    setChartAreaWidth,
    numberOfSamplesPerPixel,
    chartRef,
    cursorData: { begin, end },
    lineData,
    currentMeanLineData,
    powerLineData,
    voltageLineData,
    processing,
    processingMessage,
    processingPercent,
}: AmpereChartProperties) => {
    const liveMode = useSelector(isLiveMode);
    const traces = useSelector(getTraces);
    const { yMin, yMax, yAxisLog } = useSelector(getChartYAxisRange);
    const timestampsVisible = useSelector(isTimestampsVisible);
    const { cursorBegin, cursorEnd } = useSelector(getCursorRange);
    const windowDuration = useSelector(getWindowDuration);
    const samplingRunning = useSelector(isSamplingRunning);
    const systemTime = useSelector(showSystemTime);
    const triggerLevel = useSelector(getTriggerValue);
    const triggerOrigin = useSelector(getTriggerOrigin);
    const fileLoaded = useSelector(isFileLoaded);
    const scopePane = useSelector(isScopePane);

    const live = liveMode && samplingRunning;
    const snapping = numberOfSamplesPerPixel <= 0.16 && !live;

    const pointRadius = numberOfSamplesPerPixel <= 0.08 ? 4 : 2;
    const chartDataSets: ChartData<'line', AmpereState[]> = {
        datasets: [
            {
                borderColor: dataColor,
                borderWidth: numberOfSamplesPerPixel > 2 ? 1 : 1.5,
                fill: false,
                data: lineData,
                pointRadius: snapping ? pointRadius : 0,
                pointHoverRadius: snapping ? pointRadius : 0,
                pointHitRadius: snapping ? pointRadius : 0,
                pointBackgroundColor: colors.white,
                pointHoverBackgroundColor: dataColor,
                pointBorderWidth: 1.5,
                pointHoverBorderWidth: 1.5,
                pointBorderColor: dataColor,
                pointHoverBorderColor: dataColor,
                tension: snapping ? 0.2 : 0,
                spanGaps: true,
                segment: missingSegment,
                label: 'Current',
                xAxisID: 'xScale',
                yAxisID: 'yScale',
                // Dataset order is fixed (the plugins address datasets[0]
                // and scales.yScale); visibility is a flag, not an omission.
                hidden: !traces.current,
            },
            {
                borderColor: powerColor,
                borderWidth: 1,
                fill: false,
                data: powerLineData,
                pointRadius: 0,
                pointHoverRadius: 0,
                pointHitRadius: 0,
                tension: 0,
                spanGaps: true,
                segment: missingSegment,
                label: 'Power',
                xAxisID: 'xScale',
                yAxisID: 'yScalePower',
                hidden: !traces.power,
            },
            {
                borderColor: voltageColor,
                borderWidth: 1,
                fill: false,
                data: voltageLineData,
                pointRadius: 0,
                pointHoverRadius: 0,
                pointHitRadius: 0,
                tension: 0,
                spanGaps: true,
                segment: missingSegment,
                label: 'Voltage',
                xAxisID: 'xScale',
                yAxisID: 'yScaleVoltage',
                hidden: !traces.voltage,
            },
        ],
    };

    const showTriggerItems = scopePane && !fileLoaded;

    let min = yMin ?? undefined;
    if (min == null && yAxisLog) {
        min = 1;
    }

    const chartOptions: AmpereChartOptions = {
        scales: {
            xScale: {
                type: 'linear',
                display: true,
                min: begin > 0 ? begin : 0,
                max: begin > 0 ? end : windowDuration,
                ticks: {
                    display: timestampsVisible,
                    autoSkipPadding: 25,
                    callback: value =>
                        timestampToLabel(
                            Number.parseInt(value.toString(), 10),
                            systemTime,
                        ),
                    maxTicksLimit: 7,
                },
                border: {
                    display: true,
                },
                grid: {
                    drawOnChartArea: true,
                },
                afterFit: scale => {
                    scale.paddingRight = rightMargin;
                },
            },
            yScale: {
                type: yAxisLog ? 'logarithmic' : 'linear',
                display: traces.current,
                min,
                max: yMax != null ? yMax : undefined,
                ticks: {
                    maxTicksLimit: 7,
                    callback: nA =>
                        typeof nA === 'number' && nA >= 0
                            ? formatCurrent(nA)
                            : '',
                },
                border: {
                    display: true,
                },
                grid: {
                    drawOnChartArea: true,
                },
                afterFit: scale => {
                    scale.width = yAxisWidth;
                },
            },
            // Power rides on its own auto-ranged axis on the right; the
            // current axis keeps the user's zoom/log settings.
            yScalePower: {
                type: 'linear',
                position: 'right',
                display: traces.power,
                min: 0,
                grace: '5%',
                ticks: {
                    maxTicksLimit: 7,
                    color: powerColor,
                    callback: uW =>
                        typeof uW === 'number' && uW >= 0
                            ? formatPower(uW)
                            : '',
                },
                border: {
                    display: true,
                },
                grid: {
                    drawOnChartArea: false,
                },
                afterFit: scale => {
                    scale.width = yAxisWidth;
                },
            },
            // Voltage starts at zero: auto-ranging onto a near-constant
            // supply zooms into millivolts of noise and every new point
            // looks like a spike. A battery running 4.2 -> 3.0 V or a PV
            // cell at 0.5 V still reads fine from a zero floor.
            yScaleVoltage: {
                type: 'linear',
                position: 'right',
                display: traces.voltage,
                min: 0,
                grace: '5%',
                ticks: {
                    maxTicksLimit: 7,
                    color: voltageColor,
                    callback: v =>
                        typeof v === 'number' ? formatVoltage(v) : '',
                },
                border: {
                    display: true,
                },
                grid: {
                    drawOnChartArea: false,
                },
                afterFit: scale => {
                    scale.width = yAxisWidth;
                },
            },
        },
        parsing: false,
        maintainAspectRatio: false,
        animation: false,
        formatX: value => timestampToLabel(value, systemTime),
        crossHairValues: [
            {
                data: currentMeanLineData,
                scaleId: 'yScale',
                format: formatCurrent,
                color: dataColor,
                visible: traces.current,
            },
            {
                data: voltageLineData,
                scaleId: 'yScaleVoltage',
                format: formatVoltage,
                color: voltageColor,
                visible: traces.voltage,
            },
            {
                data: powerLineData,
                scaleId: 'yScalePower',
                format: formatPower,
                color: powerColor,
                visible: traces.power,
            },
        ],
        snapping,
        live,
        windowDuration,
        cursor: { cursorBegin, cursorEnd },
        id: 'ampereChart',
        triggerHandleVisible: showTriggerItems,
        updateTriggerLevel: level => {
            dispatch(setTriggerLevel(Math.max(0.2, level / 1000)));
        },
        triggerOrigin: showTriggerItems ? triggerOrigin : undefined,
        triggerLevel: triggerLevel * 1000,
    };

    const dispatch = useDispatch();

    const plugins = [
        missingDataPlugin,
        dragSelectPlugin,
        zoomPanPlugin,
        triggerLevelPlugin,
        triggerOriginPlugin,
        crossHairPlugin,
        {
            id: 'notifier',
            afterLayout(chart: Chart) {
                if (chart.chartArea.width <= 0) return;

                const { chartArea, width } = chart;
                // Keep the right margin, but not at the expense of the
                // power axis Chart.js has already laid out on that side.
                chartArea.right = Math.min(
                    chartArea.right,
                    width - rightMargin,
                );
                const { left, right } = chart.chartArea;
                const w = Math.trunc(right - left);
                setNumberOfPixelsInWindow(Math.min(w, 2000));
                setChartAreaWidth(w);
            },
        },
    ];

    return (
        <div className="tw-relative tw-flex tw-h-full tw-min-h-[100px] tw-flex-grow">
            {processing && (
                <div
                    className={classNames(
                        'tw-pointer-events-none tw-absolute tw-flex tw-h-full tw-w-full tw-items-center tw-justify-center tw-pl-16 tw-pr-8',
                        timestampsVisible ? 'tw-pb-[54px]' : 'tw-pb-[21px]',
                    )}
                >
                    <div className="tw-relative tw-top-[10px] tw-flex tw-h-full tw-w-full tw-flex-col tw-items-center tw-justify-center tw-gap-2 tw-bg-gray-300 tw-bg-opacity-20 tw-px-16">
                        {processingMessage && (
                            <div>{`${processingMessage} ${
                                processingPercent && processingPercent >= 0
                                    ? `(${processingPercent?.toFixed(0)})%`
                                    : ''
                            }`}</div>
                        )}
                        <Spinner size="lg" className="tw-text-nordicBlue-900" />
                    </div>
                </div>
            )}
            <Line
                ref={chartRef as ForwardedRef<ChartJSOrUndefined<'line'>>}
                // Need to typecast because of react-chartjs-2
                data={chartDataSets as ChartData<'line'>}
                options={chartOptions}
                plugins={plugins}
            />
        </div>
    );
};
