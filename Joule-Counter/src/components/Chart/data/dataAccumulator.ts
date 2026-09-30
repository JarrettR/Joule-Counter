/*
 * Copyright (c) 2015 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-4-Clause
 */

import {
    DataManager,
    frameSize,
    indexToTimestamp,
    normalizeTimeCeil,
    normalizeTimeFloor,
    numberOfDigitalChannels,
    timestampToIndex,
} from '../../../globals';
import { always0, always1, sometimes0And1 } from '../../../utils/bitConversion';
import bitDataAccumulator from './bitDataAccumulator';
import {
    type AmpereState,
    type BitState,
    ChartLineValue,
    type DigitalChannelState,
    type DigitalChannelStates,
    type TimestampType,
} from './dataTypes';

export interface RangeStats {
    /** mean current, µA */
    average: number;
    /** peak current, µA */
    max: number;
    /** duration, µs */
    delta: number;
    /** Σ current × voltage × dt over the range, µJ; NaN if no voltage */
    energy: number;
    /** mean DUT voltage, V; NaN if no voltage */
    voltage: number;
    /** samples in the range that never arrived */
    missing: number;
}

/*
 * Energy is summed sample by sample rather than taken as average current ×
 * average voltage × time: through a pulsed load those two differ, and the
 * whole point of pairing V and I per sample is to get this right.
 *
 * Samples that never arrived count at the mean of the ones that did, for
 * charge and energy alike: the best estimate without them, and the same one
 * the window statistics make.
 */
export const calcStats = (
    onComplete: (stats: RangeStats) => void,
    begin: number,
    end: number,
    abortController?: AbortController,
    onProgress?: (progress: number) => void,
) => {
    if (begin > end) {
        const temp = begin;
        begin = end;
        end = temp;
    }

    begin = Math.max(normalizeTimeCeil(begin), 0);
    end = Math.min(normalizeTimeFloor(end), DataManager().getTimestamp());

    const maxNumberOfSamplesToProcess = 10_000_000;
    const totalSamples = timestampToIndex(end) - timestampToIndex(begin) + 1;
    const buffer = Buffer.alloc(
        Math.min(totalSamples, maxNumberOfSamplesToProcess) * frameSize,
    );

    let sum = 0;
    let len = 0;
    let delta = 0;
    let max: number | undefined;
    let powerSum = 0; // µW summed over samples
    let voltageSum = 0;
    let voltageLen = 0;
    let missing = 0;
    const oneValueDelta = indexToTimestamp(1);

    const process = (b: number, e: number) =>
        new Promise<{ begin: number; end: number }>(res => {
            setTimeout(() => {
                DataManager()
                    .getData(buffer, b, e, 'end')
                    .then(data => {
                        onProgress?.((b / (end - begin)) * 100);
                        for (let n = 0; n < data.getLength(); n += 1) {
                            const v = data.getCurrentData(n);
                            if (Number.isNaN(v)) {
                                missing += 1;
                            } else {
                                if (max === undefined || v > max) {
                                    max = v;
                                }
                                sum += v;
                                len += 1;
                                const volt = data.getVoltageData(n);
                                if (!Number.isNaN(volt)) {
                                    powerSum += v * volt;
                                    voltageSum += volt;
                                    voltageLen += 1;
                                }
                            }
                        }

                        delta += data.getLength() * oneValueDelta;

                        res({
                            begin: Math.min(end, e + oneValueDelta),
                            end: Math.min(
                                end,
                                e +
                                    indexToTimestamp(
                                        maxNumberOfSamplesToProcess,
                                    ),
                            ),
                        });
                    });
            });
        }).then(range => {
            if (abortController?.signal.aborted) {
                return;
            }
            if (range.begin === end) {
                onComplete({
                    average: sum / (len || 1),
                    max: max ?? 0,
                    delta,
                    // mean power (µW) × duration (s) = µJ; with nothing
                    // missing this is the plain sum of V·I·dt
                    energy:
                        voltageLen > 0
                            ? (powerSum / voltageLen) * (delta / 1e6)
                            : NaN,
                    voltage: voltageLen > 0 ? voltageSum / voltageLen : NaN,
                    missing,
                });
            } else {
                process(range.begin, range.end);
            }
        });

    process(
        begin,
        Math.min(
            end,
            begin +
                indexToTimestamp(maxNumberOfSamplesToProcess) -
                indexToTimestamp(1),
        ),
    );
};

export interface DataAccumulator {
    bitStateAccumulator: number[];

    process: (
        begin: number,
        end: number,
        digitalChannelsToCompute: number[],
        len: number,
        windowDuration: number,
        onLoading?: (loading: boolean) => void,
    ) => Promise<AccumulatedResult>;
}

/** y is a running sum over count samples, so groups can be merged exactly.
 * partial marks a trailing group that had not filled when it was read (the
 * live edge): still valid for totals, not stable enough to draw as a mean.
 * missing counts the group's samples that never arrived.
 */
export type AverageLine = {
    x: TimestampType;
    y: number;
    count: number;
    partial?: boolean;
    missing?: number;
};

export type AccumulatedResult = {
    ampereLineData: AmpereState[];
    bitsLineData: DigitalChannelStates[];
    averageLine: AverageLine[];
    /** summed power per group, µW (current µA × voltage V) */
    powerLine: AverageLine[];
    /** summed DUT voltage per group, V */
    voltageLine: AverageLine[];
};

let cachedResult: AccumulatedResult | undefined;
let globalReadBuffer: Buffer | undefined;

const accumulate = async (
    begin: number, // normalizeTime
    end: number, // normalizeTime
    timeGroup: number,
    numberOfPointsPerGrouped: number,
    digitalChannelsToCompute: number[],
    bias?: 'start' | 'end',
    onLoading?: (loading: boolean) => void,
) => {
    begin = Math.trunc(begin / timeGroup) * timeGroup;
    end = begin + Math.ceil((end - begin) / timeGroup) * timeGroup;

    if (end > DataManager().getTimestamp()) {
        end -= timeGroup;
    }

    const bytesToRead =
        (timestampToIndex(end) - timestampToIndex(begin) + 1) * frameSize;
    if (
        !globalReadBuffer ||
        globalReadBuffer.length < bytesToRead ||
        globalReadBuffer.length > bytesToRead * 4
    ) {
        globalReadBuffer = Buffer.alloc(bytesToRead);
    }

    const data = await DataManager().getData(
        globalReadBuffer,
        begin,
        end,
        bias,
        onLoading,
    );
    const bitAccumulator =
        digitalChannelsToCompute.length > 0 ? bitDataAccumulator() : undefined;
    bitAccumulator?.initialise(digitalChannelsToCompute);
    const numberOfElements = data.getLength();
    const noOfPointToRender = numberOfElements / numberOfPointsPerGrouped;
    const needMinMaxLine = numberOfPointsPerGrouped !== 1;

    if (!needMinMaxLine) {
        const ampereLineData: AmpereState[] = new Array(
            Math.ceil(noOfPointToRender),
        );
        const powerLine: AverageLine[] = [];
        const voltageLine: AverageLine[] = [];
        for (let index = 0; index < numberOfElements; index += 1) {
            const v = data.getCurrentData(index);
            const volt = data.getVoltageData(index);
            const bits = data.getBitData(index);
            const timestamp = begin + index * timeGroup;
            const missing = Number.isNaN(v);
            if (!missing) {
                bitAccumulator?.processBits(bits);
                bitAccumulator?.processAccumulatedBits(timestamp);
                if (!Number.isNaN(volt)) {
                    powerLine.push({ x: timestamp, y: v * volt, count: 1 });
                    voltageLine.push({ x: timestamp, y: volt, count: 1 });
                }
            } else {
                // Keeps the gap in the power and voltage lines too, rather
                // than joining the samples either side of it.
                powerLine.push({ x: timestamp, y: 0, count: 0, missing: 1 });
                voltageLine.push({ x: timestamp, y: 0, count: 0, missing: 1 });
            }

            ampereLineData[index] = {
                x: timestamp,
                y: v * 1000,
                ...(missing && { missing: true }),
            };
        }

        return {
            ampereLineData,
            bitsLineData:
                bitAccumulator?.getLineData() ??
                new Array(numberOfDigitalChannels).fill({
                    mainLine: [],
                    uncertaintyLine: [],
                }),
            averageLine: ampereLineData.map(d =>
                d.missing
                    ? { x: d.x, y: 0, count: 0, missing: 1 }
                    : ({ x: d.x, y: d.y, count: 1 } as AverageLine),
            ),
            powerLine,
            voltageLine,
        };
    }

    const ampereLineData: AmpereState[] = new Array(
        Math.ceil(noOfPointToRender) * 2,
    );

    const averageLine: AverageLine[] = new Array(Math.ceil(noOfPointToRender));
    const powerLine: AverageLine[] = new Array(Math.ceil(noOfPointToRender));
    const voltageLine: AverageLine[] = new Array(Math.ceil(noOfPointToRender));

    let min: number = Number.MAX_VALUE;
    let max: number = -Number.MAX_VALUE;
    let missing = 0;

    let timestamp = begin;
    for (let index = 0; index < numberOfElements; index += 1) {
        let v = data.getCurrentData(index);
        const volt = data.getVoltageData(index);
        const bits = data.getBitData(index);
        const firstItemInGrp = index % numberOfPointsPerGrouped === 0;
        const lastItemInGrp = (index + 1) % numberOfPointsPerGrouped === 0;
        const groupIndex = Math.trunc(index / numberOfPointsPerGrouped);

        if (firstItemInGrp) {
            min = Number.MAX_VALUE;
            max = -Number.MAX_VALUE;
            missing = 0;

            averageLine[groupIndex] = {
                x: timestamp,
                y: 0,
                count: 0,
            };
            powerLine[groupIndex] = { x: timestamp, y: 0, count: 0 };
            voltageLine[groupIndex] = { x: timestamp, y: 0, count: 0 };
        }

        if (!Number.isNaN(v)) {
            if (!Number.isNaN(volt)) {
                powerLine[groupIndex].y += v * volt;
                powerLine[groupIndex].count += 1;
                voltageLine[groupIndex].y += volt;
                voltageLine[groupIndex].count += 1;
            }

            v *= 1000; // uA to nA
            if (v > max) max = v;
            if (v < min) min = v;

            bitAccumulator?.processBits(bits);

            averageLine[groupIndex] = {
                x: timestamp,
                y: averageLine[groupIndex].y + v,
                count: averageLine[groupIndex].count + 1,
            };
        } else {
            missing += 1;
        }

        if (missing > 0) {
            averageLine[groupIndex].missing = missing;
            powerLine[groupIndex].missing = missing;
            voltageLine[groupIndex].missing = missing;
        }

        ampereLineData[groupIndex * 2] = {
            x: timestamp,
            y: min > max ? undefined : min,
            ...(missing > 0 && { missing: true }),
        };

        ampereLineData[(groupIndex + 1) * 2 - 1] = {
            x: timestamp,
            y: min > max ? undefined : max,
            ...(missing > 0 && { missing: true }),
        };

        if (lastItemInGrp) {
            timestamp += timeGroup;
            if (min <= max) {
                bitAccumulator?.processAccumulatedBits(timestamp);
            }
        }
    }

    // A mean over a few samples of a pulsed load can be an order of
    // magnitude off the group's eventual value, and on an auto-ranged axis
    // that one point rescales the whole trace. Flag it instead of drawing it.
    if (numberOfElements % numberOfPointsPerGrouped !== 0) {
        const last = powerLine.length - 1;
        if (powerLine[last]) powerLine[last].partial = true;
        if (voltageLine[last]) voltageLine[last].partial = true;
    }

    return {
        ampereLineData,
        bitsLineData:
            bitAccumulator?.getLineData() ??
            new Array(numberOfDigitalChannels).fill({
                mainLine: [],
                uncertaintyLine: [],
            }),
        averageLine,
        powerLine,
        voltageLine,
    };
};

const removeCurrentSamplesOutsideScopes = <T extends AmpereState | AverageLine>(
    current: T[],
    begin: number,
    end: number,
) => current.filter(v => v.x !== undefined && v.x >= begin && v.x <= end);

const removeDigitalChannelsSamplesOutsideScopes = (
    dataChannel: DigitalChannelState[],
    begin: number,
    end: number,
) => {
    if (dataChannel.length >= 2) {
        let y = dataChannel[1].y;
        let x = dataChannel[0].x;
        let add = false;
        while (x !== undefined && x < begin && dataChannel.length >= 2) {
            add = true;
            y = dataChannel[0].y;
            dataChannel = dataChannel.slice(1);
            x = dataChannel[0].x;
        }

        if (add && x !== begin) {
            dataChannel = [
                {
                    x: begin,
                    y,
                },
                ...dataChannel,
            ];
        }

        let i = dataChannel.length - 1;
        y = dataChannel[i].y;
        x = dataChannel[i].x;
        add = false;
        while (x !== undefined && x > end && dataChannel.length >= 2) {
            add = true;
            dataChannel = dataChannel.slice(0, i);
            i = dataChannel.length - 1;
            y = dataChannel[i].y;
            x = dataChannel[i].x;
        }

        if (add) {
            dataChannel = [
                ...dataChannel,
                {
                    x: end,
                    y,
                },
            ];
        }

        return dataChannel;
    }

    return [];
};

const removeDigitalChannelStateSamplesOutsideScopes = (
    dataChannel: DigitalChannelStates,
    begin: number,
    end: number,
) => ({
    mainLine: removeDigitalChannelsSamplesOutsideScopes(
        dataChannel.mainLine,
        begin,
        end,
    ),
    uncertaintyLine: removeDigitalChannelsSamplesOutsideScopes(
        dataChannel.uncertaintyLine,
        begin,
        end,
    ),
});

const removeDigitalChannelsStatesSamplesOutsideScopes = (
    dataChannel: DigitalChannelStates[],
    begin: number,
    end: number,
) =>
    dataChannel.map(c =>
        removeDigitalChannelStateSamplesOutsideScopes(c, begin, end),
    );

const findMissingRanges = (
    accumulatedResult: AccumulatedResult,
    begin: number,
    end: number,
) => {
    const timestamps =
        accumulatedResult.ampereLineData
            .filter(v => v.x !== undefined)
            .map(v => v.x as number) ?? [];

    if (timestamps.length === 0) {
        return [
            {
                begin,
                end: Math.max(begin, end),
                location: 'front',
            },
        ];
    }

    let min = Number.MAX_VALUE;
    let max = -Number.MAX_VALUE;

    // we can be sure min and max will be written to as timestamps.length > 0
    timestamps.forEach(v => {
        if (min > v) {
            min = v;
        }

        if (max < v) {
            max = v;
        }
    });

    const result: { begin: number; end: number; location: 'front' | 'back' }[] =
        [];

    if (min > begin) {
        result.push({
            begin,
            end: Math.max(begin, min - indexToTimestamp(1)),
            location: 'front',
        });
    }

    if (max < end) {
        result.push({
            begin: Math.min(end, max + indexToTimestamp(1)),
            end,
            location: 'back',
        });
    }

    return result;
};

let cacheValidTimeGroup: number;
let cachedDigitalChannelsToCompute: number[];

const chartLineToBitState = (
    mainLineState: ChartLineValue | undefined,
    uncertaintyLineState: ChartLineValue | undefined,
): BitState => {
    if (mainLineState === undefined && uncertaintyLineState === undefined) {
        return 0;
    }
    if (
        mainLineState === ChartLineValue.one &&
        uncertaintyLineState === ChartLineValue.one
    ) {
        return always1;
    }
    if (
        mainLineState === ChartLineValue.zero &&
        uncertaintyLineState === ChartLineValue.zero
    ) {
        return always0;
    }

    return sometimes0And1;
};

const joinBitLines = (
    dataLines: DigitalChannelStates[][],
    digitalChannelsToCompute: number[],
) => {
    const timestamp: TimestampType[] = Array(8).fill(undefined);
    const bitDataProcessor =
        digitalChannelsToCompute.length > 0 ? bitDataAccumulator() : undefined;
    bitDataProcessor?.initialise(digitalChannelsToCompute);

    dataLines = dataLines.filter(d => d.length > 0);

    dataLines.forEach(dataLine => {
        dataLine.forEach((line, index) => {
            const numberOfElement = Math.min(
                line.mainLine.length,
                line.uncertaintyLine.length,
            );
            for (let i = 0; i < numberOfElement; i += 1) {
                bitDataProcessor?.processBitState(
                    chartLineToBitState(
                        line.mainLine[i].y,
                        line.uncertaintyLine[i].y,
                    ),
                    index,
                );

                if (timestamp[index] !== line.mainLine[i].x) {
                    timestamp[index] = line.mainLine[i].x;
                    bitDataProcessor?.processAccumulatedBits(timestamp[index]);
                }
            }
        });
    });

    return (
        bitDataProcessor?.getLineData() ??
        new Array(numberOfDigitalChannels).fill({
            mainLine: [],
            uncertaintyLine: [],
        })
    );
};

// true is rhs has all elements from lhs
const compareDigitalChanel = (rhs: number[], lhs: number[]) =>
    lhs.every(v => rhs.findIndex(x => x === v) !== -1);

export const resetCache = () => {
    cachedResult = undefined;
    globalReadBuffer = undefined;
};

export type DataAccumulatorInitialiser = () => DataAccumulator;
export default (): DataAccumulator => ({
    bitStateAccumulator: new Array(numberOfDigitalChannels),

    async process(
        begin,
        end,
        digitalChannelsToCompute,
        maxNumberOfPoints,
        windowDuration,
        onLoading?: (loading: boolean) => void,
    ) {
        // We want an extra sample from both end to show line going out of chart
        begin = Math.max(0, normalizeTimeFloor(begin)); // normalizeTime floors

        end = Math.min(
            DataManager().getTimestamp(),
            normalizeTimeFloor(end) === end
                ? end
                : normalizeTimeFloor(end) + DataManager().getSamplingTime(),
        );

        if (maxNumberOfPoints === 0) {
            return {
                ampereLineData: [],
                bitsLineData: [],
                averageLine: [],
                powerLine: [],
                voltageLine: [],
            };
        }

        const suggestedNoOfRawSamples =
            DataManager().getNumberOfSamplesInWindow(windowDuration);

        const numberOfPointsPerGroup = Math.ceil(
            suggestedNoOfRawSamples / maxNumberOfPoints,
        );

        const timeGroup = indexToTimestamp(numberOfPointsPerGroup);

        if (
            timeGroup !== cacheValidTimeGroup ||
            !compareDigitalChanel(
                cachedDigitalChannelsToCompute,
                digitalChannelsToCompute,
            )
        ) {
            cachedResult = undefined;
        }

        cacheValidTimeGroup = timeGroup;
        cachedDigitalChannelsToCompute = digitalChannelsToCompute;

        end = Math.min(DataManager().getTimestamp(), end);

        const getDataWithCachedResult = async () => {
            if (!cachedResult || DataManager().getTotalSavedRecords() === 0)
                return accumulate(
                    begin,
                    end,
                    timeGroup,
                    numberOfPointsPerGroup,
                    digitalChannelsToCompute,
                    undefined,
                    onLoading,
                );

            const requiredEnd = Math.min(
                Math.ceil(end / timeGroup) * timeGroup,
                DataManager().getTimestamp(),
            );

            const requiredBegin = Math.trunc(begin / timeGroup) * timeGroup;

            const usableCachedData: AccumulatedResult = {
                ampereLineData: removeCurrentSamplesOutsideScopes(
                    cachedResult.ampereLineData,
                    requiredBegin,
                    requiredEnd,
                ),
                bitsLineData: removeDigitalChannelsStatesSamplesOutsideScopes(
                    cachedResult.bitsLineData,
                    requiredBegin,
                    requiredEnd,
                ),
                averageLine: removeCurrentSamplesOutsideScopes(
                    cachedResult.averageLine,
                    requiredBegin,
                    requiredEnd,
                ),
                powerLine: removeCurrentSamplesOutsideScopes(
                    cachedResult.powerLine,
                    requiredBegin,
                    requiredEnd,
                ),
                voltageLine: removeCurrentSamplesOutsideScopes(
                    cachedResult.voltageLine,
                    requiredBegin,
                    requiredEnd,
                ),
            };

            if (usableCachedData.ampereLineData.length === 0) {
                return accumulate(
                    begin,
                    end,
                    timeGroup,
                    numberOfPointsPerGroup,
                    digitalChannelsToCompute,
                    undefined,
                    onLoading,
                );
            }

            const rangesToLoad = findMissingRanges(
                usableCachedData,
                begin,
                end,
            );

            const frontRange = rangesToLoad.find(r => r.location === 'front');
            const backDataRange = rangesToLoad.find(r => r.location === 'back');

            let frontData: Awaited<ReturnType<typeof accumulate>> | undefined;
            let backData: Awaited<ReturnType<typeof accumulate>> | undefined;

            if (frontRange) {
                frontData = await accumulate(
                    frontRange.begin,
                    frontRange.end,
                    timeGroup,
                    numberOfPointsPerGroup,
                    digitalChannelsToCompute,
                    undefined,
                    onLoading,
                );
            }

            if (backDataRange) {
                backData = await accumulate(
                    backDataRange.begin,
                    backDataRange.end,
                    timeGroup,
                    numberOfPointsPerGroup,
                    digitalChannelsToCompute,
                    undefined,
                    onLoading,
                );
            }

            // accumulate() aligns its range to whole groups, so the fresh
            // front/back data re-covers the cached edge groups. The cached
            // copy of the last group was made while it was still filling
            // (live mode) and its mean is over a handful of samples; the
            // fresh one wins. For the min/max current band the stale copy
            // sat inside the fresh one and never showed, for the power and
            // voltage means it did.
            // The accumulated arrays are pre-sized and can be sparse when the
            // live tail is not on disk yet, so holes have to be skipped
            // explicitly; filter() does, find() does not.
            const firstX = (lines: { x: TimestampType }[]) =>
                lines.filter(l => l && l.x !== undefined)[0]?.x;
            const dedupe = <T extends { x: TimestampType }>(
                front: T[] | undefined,
                cached: T[],
                back: T[] | undefined,
            ): T[] => {
                const cachedStart = firstX(cached);
                const backStart = back ? firstX(back) : undefined;
                return [
                    // The front fill's trailing group is the partial one;
                    // the cache has it complete.
                    ...(front ?? []).filter(
                        f =>
                            f &&
                            f.x !== undefined &&
                            (cachedStart === undefined || f.x < cachedStart),
                    ),
                    // The cache's trailing group was partial when cached;
                    // the back fill has it complete.
                    ...cached.filter(
                        c =>
                            c &&
                            c.x !== undefined &&
                            (backStart === undefined || c.x < backStart),
                    ),
                    ...(back ?? []).filter(b => b && b.x !== undefined),
                ];
            };

            return {
                ampereLineData: dedupe(
                    frontData?.ampereLineData,
                    usableCachedData.ampereLineData,
                    backData?.ampereLineData,
                ),
                bitsLineData: joinBitLines(
                    [
                        frontData?.bitsLineData ?? [],
                        usableCachedData.bitsLineData,
                        backData?.bitsLineData ?? [],
                    ],
                    digitalChannelsToCompute,
                ),
                averageLine: dedupe(
                    frontData?.averageLine,
                    usableCachedData.averageLine,
                    backData?.averageLine,
                ),
                powerLine: dedupe(
                    frontData?.powerLine,
                    usableCachedData.powerLine,
                    backData?.powerLine,
                ),
                voltageLine: dedupe(
                    frontData?.voltageLine,
                    usableCachedData.voltageLine,
                    backData?.voltageLine,
                ),
            };
        };

        cachedResult = await getDataWithCachedResult();

        return { ...cachedResult };
    },
});
