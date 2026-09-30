/*
 * Copyright (c) 2015 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-4-Clause
 */

import React, {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
    type AppDispatch,
    type AppThunk,
} from '@nordicsemiconductor/pc-nrfconnect-shared';
import {
    Chart as ChartJS,
    LinearScale,
    LineElement,
    LogarithmicScale,
    PointElement,
    Title,
} from 'chart.js';

import Minimap from '../../features/minimap/Minimap';
import {
    DataManager,
    getSamplesPerSecond,
    indexToTimestamp,
    timestampToIndex,
} from '../../globals';
import { HotkeyActionType, useHotkeyAction } from '../../hooks/useHotkeyAction';
import {
    type DataAccumulatorInstance,
    isInitialised,
    useLazyInitializedRef,
} from '../../hooks/useLazyInitializedRef';
import { type RootState } from '../../slices';
import {
    getDataIntegrity,
    isFileLoaded,
    isSamplingRunning,
} from '../../slices/appSlice';
import {
    chartCursorAction,
    chartWindowAction,
    getChartDigitalChannelInfo,
    getChartXAxisRange,
    getCursorRange,
    getForceRerender,
    getRecordingMode,
    isLiveMode,
    isSessionActive,
    MAX_WINDOW_DURATION,
    setFPS,
    setLiveMode,
} from '../../slices/chartSlice';
import { getProgress } from '../../slices/triggerSlice';
import { formatDurationHTML } from '../../utils/duration';
import { isDataLoggerPane } from '../../utils/panes';
import { type booleanTupleOf8 } from '../../utils/persistentStore';
import type { AmpereChartJS } from './AmpereChart';
import AmpereChart from './AmpereChart';
import ChartTop from './ChartTop';
import dataAccumulatorInitialiser, {
    calcStats,
    type RangeStats,
} from './data/dataAccumulator';
import { type AmpereState, type DigitalChannelStates } from './data/dataTypes';
import DigitalChannels from './DigitalChannels';
import SelectionStatBox from './SelectionStatBox';
import { ValueRaw } from './StatBoxHelpers';
import TimeSpanBottom from './TimeSpan/TimeSpanBottom';
import TimeSpanTop from './TimeSpan/TimeSpanTop';
import WindowStatBox from './WindowStatBox';

// chart.js way of doing tree-shaking, meaning that components that will be included in the bundle
// must be imported and registered. The registered components are used in both AmpChart and DigitalChannels.
ChartJS.register(
    LineElement,
    PointElement,
    LinearScale,
    LogarithmicScale,
    Title,
);

export type CursorData = {
    cursorBegin: number | null | undefined;
    cursorEnd: number | null | undefined;
    begin: number;
    end: number;
};

let nextUpdateRequests: (() => Promise<void>) | undefined;
let chartUpdateInprogress = false;

const executeChartUpdateOperation = async () => {
    if (!nextUpdateRequests || chartUpdateInprogress) return;

    const nextTask = nextUpdateRequests;
    nextUpdateRequests = undefined;

    chartUpdateInprogress = true;
    try {
        await nextTask();
    } catch {
        // do nothing
    }

    chartUpdateInprogress = false;
    executeChartUpdateOperation();
};

const updateChart = async (
    dataProcessor: DataAccumulatorInstance,
    numberOfPixelsInWindow: number,
    digitalChannels: booleanTupleOf8,
    digitalChannelsVisible: boolean,
    windowBegin: number,
    windowDuration: number,
    windowEnd: number,
    setData: (data: {
        ampereLineData: AmpereState[];
        currentMeanLineData: AmpereState[];
        powerLineData: AmpereState[];
        voltageLineData: AmpereState[];
        bitsLineData: DigitalChannelStates[];
    }) => void,
    setProcessing: (processing: boolean) => void,
    setWindowStats: (state: RangeStats | null) => void,
) => {
    if (
        !isInitialised(dataProcessor) ||
        DataManager().getTotalSavedRecords() === 0
    ) {
        return;
    }

    const sampleFreq = getSamplesPerSecond();

    const digitalChannelsWindowLimit = 3e12 / sampleFreq;
    const zoomedOutTooFarForDigitalChannels =
        windowDuration > digitalChannelsWindowLimit;

    const digitalChannelsToDisplay = digitalChannels
        .map((isVisible, channelNumber) => (isVisible ? channelNumber : null))
        .filter(channelNumber => channelNumber != null) as number[];

    const digitalChannelsToCompute =
        !zoomedOutTooFarForDigitalChannels && digitalChannelsVisible
            ? digitalChannelsToDisplay
            : [];

    const processedData = await dataProcessor.process(
        windowBegin,
        windowEnd,
        zoomedOutTooFarForDigitalChannels
            ? []
            : (digitalChannelsToCompute as number[]),
        Math.min(indexToTimestamp(windowDuration), numberOfPixelsInWindow),
        windowDuration,
        setProcessing,
    );

    const avgTemp = processedData.averageLine.reduce(
        (previousValue, currentValue) => ({
            sum: previousValue.sum + currentValue.y,
            count: previousValue.count + currentValue.count,
        }),
        {
            sum: 0,
            count: 0,
        },
    );
    const average = avgTemp.sum / avgTemp.count / 1000;

    const filteredAmpereLine = processedData.ampereLineData.filter(
        v => v.y != null && !Number.isNaN(v.y),
    );
    let max = filteredAmpereLine.length > 0 ? -Number.MAX_VALUE : 0;

    filteredAmpereLine.forEach(v => {
        if (v.y != null && v.y > max) {
            max = v.y;
        }
    });

    max /= 1000;

    // powerLine/voltageLine carry per-group sums with counts, so the window
    // totals below are exact over every sample in the window, not over the
    // rendered points.
    const sumLines = (lines: { y: number; count: number }[]) =>
        lines.reduce(
            (acc, l) => ({ sum: acc.sum + l.y, count: acc.count + l.count }),
            { sum: 0, count: 0 },
        );
    const powerTotals = sumLines(processedData.powerLine);
    const voltageTotals = sumLines(processedData.voltageLine);
    const meanLine = (
        line: {
            x: number | undefined;
            y: number;
            count: number;
            partial?: boolean;
            missing?: number;
        }[],
    ) =>
        line.map(p => ({
            x: p.x,
            y: p.count > 0 && !p.partial ? p.y / p.count : undefined,
            ...((p.missing ?? 0) > 0 && { missing: true }),
        }));
    const powerLineData: AmpereState[] = meanLine(processedData.powerLine);
    const voltageLineData: AmpereState[] = meanLine(processedData.voltageLine);
    // The current trace is a min/max band once zoomed out; the crosshair
    // reads the mean instead, like it does for power and voltage.
    const currentMeanLineData: AmpereState[] = meanLine(
        processedData.averageLine,
    );

    const missing = processedData.averageLine.reduce(
        (n, p) => n + (p.missing ?? 0),
        0,
    );

    const delta =
        DataManager().getTotalSavedRecords() > 0
            ? Math.min(windowEnd, DataManager().getTimestamp()) -
              windowBegin +
              indexToTimestamp(1)
            : 0;

    setData({
        ampereLineData: processedData.ampereLineData,
        currentMeanLineData,
        powerLineData,
        voltageLineData,
        bitsLineData: processedData.bitsLineData,
    });

    setWindowStats({
        max,
        average,
        delta,
        // mean power (µW) over the window × its duration (s) = µJ
        energy:
            powerTotals.count > 0
                ? (powerTotals.sum / powerTotals.count) * (delta / 1e6)
                : NaN,
        voltage:
            voltageTotals.count > 0
                ? voltageTotals.sum / voltageTotals.count
                : NaN,
        missing,
    });
};

const formatCount = (n: number) => n.toLocaleString('en-US');

/*
 * How much of the stream never made it into the data on screen, and why:
 * counted by the device while sampling, saved with the session, and shown
 * again when it is loaded.
 */
export const DataIntegrityStatBox = () => {
    const integrity = useSelector(getDataIntegrity);
    const samplingRunning = useSelector(isSamplingRunning);
    const fileLoaded = useSelector(isFileLoaded);
    const sessionActive = useSelector(isSessionActive);

    let source = '';
    if (integrity) {
        if (samplingRunning) source = 'since sampling started';
        else if (fileLoaded) source = 'as saved with the session';
        else source = 'last recording';
    }

    const lostTime = integrity
        ? integrity.lostSamples * integrity.samplingTimeUs
        : 0;

    return (
        <div className="tw-preflight tw-flex tw-w-full tw-flex-col tw-gap-1 tw-text-center">
            <div className="tw-flex tw-h-3.5 tw-items-center tw-justify-between">
                <h2 className="tw-inline tw-text-[10px] tw-uppercase">
                    Data integrity
                </h2>
                <span className="tw-text-[10px]">{source}</span>
            </div>
            <div className="tw-flex tw-flex-row tw-gap-[1px] tw-border tw-border-solid tw-border-gray-200 tw-bg-gray-200">
                {integrity ? (
                    <>
                        <ValueRaw
                            label="lost data"
                            value={
                                integrity.lostSamples > 0
                                    ? formatDurationHTML(lostTime)
                                    : 'none'
                            }
                            alert={integrity.lostSamples > 0}
                            white
                            title="Time covered by samples the kit took that never reached the app. They are marked red on the chart."
                        />
                        <ValueRaw
                            label="lost samples"
                            value={formatCount(integrity.lostSamples)}
                            alert={integrity.lostSamples > 0}
                            white
                            title="The same, counted in samples at the kit's sample rate."
                        />
                        <ValueRaw
                            label="gaps"
                            value={formatCount(integrity.gaps)}
                            alert={integrity.gaps > 0}
                            white
                            title="Separate stretches of lost samples."
                        />
                        <ValueRaw
                            label="kit buffer overflows"
                            value={formatCount(integrity.kitOverflows)}
                            alert={integrity.kitOverflows > 0}
                            white
                            title="Gaps where the kit had to drop samples because the computer did not read them out fast enough, for example while busy or behind a USB hub."
                        />
                        <ValueRaw
                            label="CRC errors"
                            value={formatCount(integrity.crcErrors)}
                            alert={integrity.crcErrors > 0}
                            white
                            title="Blocks of samples rejected because their checksum did not match: damaged on the way from the kit."
                        />
                    </>
                ) : (
                    <div className="tw-flex tw-h-14 tw-w-full tw-flex-row tw-items-center tw-justify-center tw-bg-gray-100 tw-text-xs tw-text-gray-700">
                        {sessionActive
                            ? 'Not recorded for this data. Missing samples are still marked red on the chart.'
                            : 'Shown once sampling starts'}
                    </div>
                )}
            </div>
        </div>
    );
};

const Chart = () => {
    const dispatch = useDispatch<AppDispatch>();
    const recordingMode = useSelector(getRecordingMode);
    const liveMode = useSelector(isLiveMode) && recordingMode === 'DataLogger';
    const rerenderTrigger = useSelector(getForceRerender);
    const samplingRunning = useSelector(isSamplingRunning);
    const triggerProgress = useSelector(getProgress);
    const dataLoggerPane = useSelector(isDataLoggerPane);

    const waitingForTrigger =
        samplingRunning &&
        recordingMode === 'Scope' &&
        (DataManager().getTimestamp() === 0 ||
            !!triggerProgress.progressMessage);

    const chartWindow = useCallback(
        (
            windowBegin: number,
            windowEnd: number,
            yMin?: number | null,
            yMax?: number | null,
        ) =>
            dispatch(
                chartWindowAction(
                    windowEnd,
                    windowEnd - windowBegin,
                    yMin,
                    yMax,
                ),
            ),
        [dispatch],
    );

    const chartReset = useCallback(
        windowDuration =>
            dispatch(
                chartWindowAction(
                    DataManager().getTimestamp() - windowDuration,
                    windowDuration,
                ),
            ),
        [dispatch],
    );

    const chartCursor = useCallback(
        (cursorBegin, cursorEnd) =>
            dispatch(chartCursorAction({ cursorBegin, cursorEnd })),
        [dispatch],
    );

    const hotkeySelectAllCb = useCallback(() => {
        if (DataManager().getTimestamp() > 0) {
            chartCursor(0, DataManager().getTimestamp());
        }
    }, [chartCursor]);
    useHotkeyAction(HotkeyActionType.SELECT_ALL, hotkeySelectAllCb);

    const hotkeyZoomToSelectionCb = useCallback(() => {
        const zoomToSelectedArea =
            (): AppThunk<RootState> => (_dispatch, getState) => {
                const { cursorBegin, cursorEnd } = getCursorRange(getState());
                if (cursorBegin != null && cursorEnd != null) {
                    chartWindow(cursorBegin, cursorEnd);
                }
            };

        dispatch(zoomToSelectedArea());
    }, [dispatch, chartWindow]);
    useHotkeyAction(
        HotkeyActionType.ZOOM_TO_SELECTION,
        hotkeyZoomToSelectionCb,
    );

    const { digitalChannels, digitalChannelsVisible } = useSelector(
        getChartDigitalChannelInfo,
    );

    const { cursorBegin, cursorEnd } = useSelector(getCursorRange);

    const {
        windowBeginLock,
        windowEndLock,
        xAxisMax,
        windowDuration,
        windowBegin,
        windowEnd,
    } = useSelector(getChartXAxisRange);

    const chartRef = useRef<AmpereChartJS | null>(null);

    const dataProcessor = useLazyInitializedRef(
        dataAccumulatorInitialiser,
    ).current;

    const sampleFreq = useSelector(getSamplesPerSecond);

    const digitalChannelsWindowLimit = 3e12 / sampleFreq;
    const zoomedOutTooFarForDigitalChannels =
        windowDuration > digitalChannelsWindowLimit;

    const cursorData: CursorData = useMemo(
        () => ({
            cursorBegin,
            cursorEnd,
            begin: windowBegin,
            end: windowEnd,
        }),
        [cursorBegin, cursorEnd, windowBegin, windowEnd],
    );

    const [numberOfPixelsInWindow, setNumberOfPixelsInWindow] = useState(0);
    const [chartAreaWidth, setChartAreaWidth] = useState(0);

    const resetCursor = useCallback(() => {
        selectionStateAbortController.current?.abort();
        chartCursor(null, null);
    }, [chartCursor]);
    useHotkeyAction(HotkeyActionType.SELECT_NONE, resetCursor);

    const zoomPanCallback = useCallback(
        (
            beginX?: number,
            endX?: number,
            beginY?: number | null,
            endY?: number | null,
        ) => {
            if (beginX === undefined || endX === undefined) {
                chartReset(windowDuration);
                return;
            }

            const earliestDataTime = 0;
            const samplesPerSecond = getSamplesPerSecond();
            const maxWindowWidth = MAX_WINDOW_DURATION / samplesPerSecond;

            const minLimit = windowBeginLock || earliestDataTime;
            const maxLimit =
                windowEndLock ||
                Math.max(DataManager().getTimestamp(), maxWindowWidth);

            const newBeginX = Math.max(beginX, minLimit);
            const newEndX = Math.min(endX, maxLimit);

            dispatch(setLiveMode(false));

            chartWindow(newBeginX, newEndX, beginY, endY);
        },
        [
            windowBeginLock,
            windowEndLock,
            windowDuration,
            chartWindow,
            chartReset,
            dispatch,
        ],
    );

    /** Center the graph inside the window
     * @param {number} localWindowDuration
     */
    const zoomToWindow = useCallback(
        localWindowDuration => {
            if (liveMode) {
                chartReset(localWindowDuration);
                return;
            }

            const center = (windowBegin + windowEnd) / 2;
            let localWindowBegin = center - localWindowDuration / 2;
            let localWindowEnd = center + localWindowDuration / 2;
            if (localWindowEnd > windowEnd) {
                localWindowBegin -= localWindowEnd - windowEnd;
                localWindowEnd = windowEnd;
            }
            chartWindow(localWindowBegin, localWindowEnd);
        },
        [liveMode, windowBegin, windowEnd, chartWindow, chartReset],
    );

    useEffect(() => {
        if (!chartRef.current) {
            return;
        }
        if (chartRef.current.dragSelect) {
            chartRef.current.dragSelect.callback = chartCursor;
        }
        if (chartRef.current.zoomPan) {
            chartRef.current.zoomPan.zoomPanCallback = zoomPanCallback;
        }
    }, [chartCursor, zoomPanCallback]);

    const samplesPerPixel = useMemo(() => {
        const samplesInWindowView = timestampToIndex(
            windowDuration,
            sampleFreq,
        );
        return numberOfPixelsInWindow === 0
            ? 2
            : samplesInWindowView / numberOfPixelsInWindow;
    }, [numberOfPixelsInWindow, windowDuration, sampleFreq]);

    const [data, setData] = useState<{
        ampereLineData: AmpereState[];
        currentMeanLineData: AmpereState[];
        powerLineData: AmpereState[];
        voltageLineData: AmpereState[];
        bitsLineData: DigitalChannelStates[];
    }>({
        ampereLineData: [],
        currentMeanLineData: [],
        powerLineData: [],
        voltageLineData: [],
        bitsLineData: [],
    });

    const [windowStats, setWindowStats] = useState<RangeStats | null>(null);

    const [selectionStats, setSelectionStats] = useState<RangeStats | null>(
        null,
    );

    const [selectionStatsProcessing, setSelectionStatsProcessing] =
        useState(false);
    const [
        selectionStatsProcessingProgress,
        setSelectionStatsProcessingProgress,
    ] = useState(0);
    const selectionStateAbortController = useRef<AbortController>();

    useEffect(() => {
        if (cursorBegin != null && cursorEnd != null) {
            selectionStateAbortController.current?.abort();
            setSelectionStatsProcessing(true);
            selectionStateAbortController.current = new AbortController();
            setSelectionStatsProcessingProgress(0);
            selectionStateAbortController.current.signal.addEventListener(
                'abort',
                () => setSelectionStatsProcessing(false),
            );
            const debounce = setTimeout(
                () =>
                    calcStats(
                        stats => {
                            setSelectionStats(stats);
                            setSelectionStatsProcessing(false);
                        },
                        cursorBegin,
                        cursorEnd,
                        selectionStateAbortController.current,
                        setSelectionStatsProcessingProgress,
                    ),
                300,
            );
            return () => {
                clearTimeout(debounce);
                selectionStateAbortController.current?.abort();
            };
        }

        setSelectionStats(null);
    }, [cursorBegin, cursorEnd, rerenderTrigger]);

    const [processing, setProcessing] = useState(false);

    useEffect(() => {
        if (xAxisMax === 0) {
            setData({
                ampereLineData: [],
                currentMeanLineData: [],
                powerLineData: [],
                voltageLineData: [],
                bitsLineData: [],
            });
            setWindowStats(null);
        }
    }, [xAxisMax]);

    const lastFPSUpdate = useRef<number>(performance.now());
    const fpsCounter = useRef<number>(0);

    useEffect(() => {
        const now = performance.now();
        if (liveMode) {
            nextUpdateRequests = () => {
                fpsCounter.current += 1;
                return updateChart(
                    dataProcessor,
                    numberOfPixelsInWindow,
                    digitalChannels,
                    digitalChannelsVisible,
                    windowBegin,
                    windowDuration,
                    windowEnd,
                    setData,
                    setProcessing,
                    setWindowStats,
                );
            };
            executeChartUpdateOperation();

            const updateFPSValue = now - lastFPSUpdate.current > 1000;

            if (updateFPSValue) {
                dispatch(setFPS(fpsCounter.current));
                fpsCounter.current = 0;
                lastFPSUpdate.current = now;
            }
        }
    }, [
        xAxisMax,
        liveMode,
        windowBegin,
        windowEnd,
        rerenderTrigger,
        dispatch,
        dataProcessor,
        numberOfPixelsInWindow,
        digitalChannels,
        digitalChannelsVisible,
        windowDuration,
    ]);

    const lastPositions = useRef({
        windowBegin,
        windowEnd,
    });

    useEffect(() => {
        if (!liveMode && DataManager().getTotalSavedRecords() > 0) {
            nextUpdateRequests = () =>
                updateChart(
                    dataProcessor,
                    numberOfPixelsInWindow,
                    digitalChannels,
                    digitalChannelsVisible,
                    windowBegin,
                    windowDuration,
                    windowEnd,
                    setData,
                    setProcessing,
                    setWindowStats,
                );
            executeChartUpdateOperation();

            lastPositions.current.windowBegin = windowBegin;
            lastPositions.current.windowEnd = windowEnd;
        }
    }, [
        windowBegin,
        liveMode,
        windowEnd,
        rerenderTrigger,
        dispatch,
        dataProcessor,
        numberOfPixelsInWindow,
        digitalChannels,
        digitalChannelsVisible,
        windowDuration,
    ]);

    return (
        <div className="tw-relative tw-flex tw-h-full tw-w-full tw-flex-col tw-justify-between tw-gap-4 tw-text-gray-600">
            <div className="scroll-bar-white-bg tw-flex tw-h-full tw-flex-col tw-overflow-y-auto tw-overflow-x-hidden tw-bg-white tw-p-2">
                <ChartTop
                    onLiveModeChange={isLive => {
                        dispatch(setLiveMode(isLive));
                    }}
                    live={liveMode}
                    zoomToWindow={zoomToWindow}
                    chartRef={chartRef}
                    windowDuration={windowDuration}
                />
                <TimeSpanTop width={chartAreaWidth + 1} />
                <AmpereChart
                    processing={processing || waitingForTrigger}
                    processingMessage={
                        waitingForTrigger
                            ? (triggerProgress.progressMessage ??
                              'Waiting for trigger')
                            : undefined
                    }
                    processingPercent={triggerProgress.progress}
                    setNumberOfPixelsInWindow={setNumberOfPixelsInWindow}
                    setChartAreaWidth={setChartAreaWidth}
                    numberOfSamplesPerPixel={samplesPerPixel}
                    chartRef={chartRef}
                    cursorData={cursorData}
                    lineData={data.ampereLineData}
                    currentMeanLineData={data.currentMeanLineData}
                    powerLineData={data.powerLineData}
                    voltageLineData={data.voltageLineData}
                />
                <TimeSpanBottom
                    cursorBegin={cursorBegin}
                    cursorEnd={cursorEnd}
                    width={chartAreaWidth + 1}
                />

                <div className="tw-flex tw-flex-col tw-gap-4 tw-py-4 tw-pl-16 tw-pr-8">
                    {dataLoggerPane && (
                        <div>
                            <Minimap />
                        </div>
                    )}
                    <div className="tw-flex tw-flex-grow tw-flex-wrap tw-gap-2">
                        <WindowStatBox
                            average={
                                windowStats?.average ? windowStats.average : 0
                            }
                            max={windowStats?.max ? windowStats.max : 0}
                            delta={windowStats?.delta ? windowStats.delta : 0}
                            energy={windowStats?.energy ?? NaN}
                            voltage={windowStats?.voltage ?? NaN}
                            missing={windowStats?.missing ?? 0}
                        />
                        <SelectionStatBox
                            resetCursor={resetCursor}
                            progress={selectionStatsProcessingProgress}
                            processing={selectionStatsProcessing}
                            chartWindow={chartWindow}
                            {...selectionStats}
                        />
                    </div>
                    <DataIntegrityStatBox />
                </div>
            </div>
            {digitalChannelsVisible && (
                <DigitalChannels
                    lineData={data.bitsLineData}
                    digitalChannels={digitalChannels}
                    zoomedOutTooFar={zoomedOutTooFarForDigitalChannels}
                    /* ts-expect-error -- temporary */
                    cursorData={cursorData}
                />
            )}
        </div>
    );
};

export default Chart;
