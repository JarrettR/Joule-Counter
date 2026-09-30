/*
 * Copyright (c) 2015 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-4-Clause
 */

/* eslint-disable no-bitwise */
/* eslint-disable @typescript-eslint/no-non-null-assertion -- TODO: Remove, only added for conservative refactoring to typescript */

import {
    type AppThunk,
    type Device,
    logger,
} from '@nordicsemiconductor/pc-nrfconnect-shared';
import describeError from '@nordicsemiconductor/pc-nrfconnect-shared/src/logging/describeError';
import { unit } from 'mathjs';

import { resetCache } from '../components/Chart/data/dataAccumulator';
import SerialDevice from '../device/serialDevice';
import { type SampleValues, type StreamIntegrity } from '../device/types';
import {
    miniMapAnimationAction,
    resetMinimap,
    triggerForceRerender as triggerForceRerenderMiniMap,
} from '../features/minimap/minimapSlice';
import { startPreventSleep, stopPreventSleep } from '../features/preventSleep';
import {
    DataManager,
    frameSize,
    indexToTimestamp,
    microSecondsPerSecond,
} from '../globals';
import { type RootState } from '../slices';
import {
    clearFileLoadedAction,
    deviceClosedAction,
    deviceOpenedAction,
    getDiskFullTrigger,
    getSessionRootFolder,
    isSavePending,
    samplingStartAction,
    samplingStoppedAction,
    setDataIntegrity,
    setDeviceRunningAction,
    setPowerModeAction,
    setSavePending,
} from '../slices/appSlice';
import {
    animationAction,
    chartWindowAction,
    chartWindowUnLockAction,
    clearRecordingMode,
    getRecordingMode,
    type RecordingMode,
    resetChartTime,
    resetCursorAndChart,
    setLatestDataTimestamp,
    setRecordingMode,
    triggerForceRerender as triggerForceRerenderMainChart,
} from '../slices/chartSlice';
import {
    getSampleFrequency,
    setSamplingAttrsAction,
} from '../slices/dataLoggerSlice';
import { updateGainsAction } from '../slices/gainsSlice';
import {
    clearProgress,
    type DigitalChannelTriggerLogic,
    DigitalChannelTriggerStatesEnum,
    getTriggerOffset,
    getTriggerRecordingLength,
    resetTriggerOrigin,
    setProgress,
    setTriggerActive,
    setTriggerOrigin,
    type TriggerEdge,
} from '../slices/triggerSlice';
import { updateRegulator as updateRegulatorAction } from '../slices/voltageRegulatorSlice';
import { convertBits16 } from '../utils/bitConversion';
import { convertTimeToSeconds } from '../utils/duration';
import { isDiskFull } from '../utils/fileUtils';
import { isDataLoggerPane } from '../utils/panes';
import {
    type digitalChannelStateTupleOf8,
    setSpikeFilter as persistSpikeFilter,
} from '../utils/persistentStore';

let device: null | SerialDevice = null;
let updateRequestInterval: NodeJS.Timeout | undefined;
let releaseFileWriteListener: (() => void) | undefined;
let previousUnsignedBits: number | undefined;

// Until when the stream's loss counters describe the data on screen: while
// sampling, and a moment after a stop for the stream's tail. After that a
// loaded file may own the figures.
let integrityLiveUntil = 0;

const sameIntegrity = (a: StreamIntegrity, b: StreamIntegrity | null) =>
    b !== null &&
    a.lostSamples === b.lostSamples &&
    a.gaps === b.gaps &&
    a.kitOverflows === b.kitOverflows &&
    a.crcErrors === b.crcErrors &&
    a.samplingTimeUs === b.samplingTimeUs;

const publishIntegrity = (
    dispatch: (action: ReturnType<typeof setDataIntegrity>) => unknown,
    shown: StreamIntegrity | null = null,
) => {
    if (!device) return;
    const integrity = device.getStreamIntegrity();
    if (sameIntegrity(integrity, shown)) return;
    DataManager().setIntegrity(integrity);
    dispatch(setDataIntegrity(integrity));
};

export const setupOptions =
    (recordingMode: RecordingMode): AppThunk<RootState, Promise<void>> =>
    async (dispatch, getState) => {
        if (!device) return;
        try {
            await DataManager().reset();
            dispatch(setDataIntegrity(null));
            dispatch(resetChartTime());
            dispatch(resetMinimap());

            const sampleFreq = getSampleFrequency(getState());

            switch (recordingMode) {
                case 'DataLogger':
                    DataManager().setSamplesPerSecond(sampleFreq);
                    DataManager().initializeLiveSession(
                        getSessionRootFolder(getState()),
                    );
                    break;
                case 'Scope':
                    DataManager().initializeTriggerSession(60);
                    break;
            }

            releaseFileWriteListener?.();
            releaseFileWriteListener = DataManager().onFileWrite?.(() => {
                isDiskFull(
                    getDiskFullTrigger(getState()),
                    getSessionRootFolder(getState()),
                ).then(isFull => {
                    if (isFull) {
                        logger.warn(
                            'Session stopped. Disk full trigger value reached.',
                        );
                        dispatch(samplingStop());
                    }
                });
            });
        } catch (err) {
            logger.error(err);
        }
        dispatch(chartWindowUnLockAction());
        dispatch(animationAction());
    };

// Only used by Data Logger Pane
/* Start reading current measurements */
export const samplingStart =
    (): AppThunk<RootState, Promise<void>> => async (dispatch, getState) => {
        const mode: RecordingMode = isDataLoggerPane(getState())
            ? 'DataLogger'
            : 'Scope';

        dispatch(setRecordingMode(mode));
        dispatch(setTriggerActive(false));
        dispatch(resetTriggerOrigin());

        // Reset previous values for trigger detection
        previousUnsignedBits = undefined;

        // Prepare global options
        await dispatch(setupOptions(mode));

        dispatch(resetCursorAndChart());
        dispatch(samplingStartAction());

        const sampleFreq = getSampleFrequency(getState());

        switch (mode) {
            case 'DataLogger':
                DataManager().setSamplesPerSecond(sampleFreq);
                break;
            case 'Scope':
                DataManager().setSamplesPerSecond(
                    getState().app.dataLogger.maxSampleFreq,
                );
                break;
        }
        await device!.ppkAverageStart();
        integrityLiveUntil = Infinity;
        publishIntegrity(dispatch);
        startPreventSleep();
    };

export const samplingStop =
    (): AppThunk<RootState, Promise<void>> => async dispatch => {
        latestTrigger = undefined;
        if (!device) return;
        dispatch(clearRecordingMode());
        dispatch(samplingStoppedAction());
        await device.ppkAverageStop();
        // The stream's tail, and any loss in it, is still on its way.
        integrityLiveUntil = Date.now() + 2000;
        stopPreventSleep();
        releaseFileWriteListener?.();
    };

export const updateSpikeFilter = (): AppThunk<RootState> => (_, getState) => {
    const { spikeFilter } = getState().app;
    persistSpikeFilter(spikeFilter);
    device!.ppkSetSpikeFilter(spikeFilter);
};

export const close =
    (): AppThunk<RootState, Promise<void>> => async (dispatch, getState) => {
        clearInterval(updateRequestInterval);
        if (!device) {
            return;
        }
        if (getState().app.app.samplingRunning) {
            await dispatch(samplingStop());
        }

        await device.stop();
        device.removeAllListeners();
        device = null;
        dispatch(deviceClosedAction());
        logger.info('PPK closed');
    };

const initGains = (): AppThunk<RootState, Promise<void>> => async dispatch => {
    if (!device!.capabilities.ppkSetUserGains) {
        return;
    }
    const { ug } = device!.modifiers;
    // if any value is ug is outside of [0.9..1.1] range:
    if (ug.reduce((p, c) => Math.abs(c - 1) > 0.1 || p, false)) {
        logger.info(
            'Found out-of-range user gain, setting all gains back to 1.0',
        );
        ug.splice(0, 5, 1, 1, 1, 1, 1);
        await device!.ppkSetUserGains(0, ug[0]);
        await device!.ppkSetUserGains(1, ug[1]);
        await device!.ppkSetUserGains(2, ug[2]);
        await device!.ppkSetUserGains(3, ug[3]);
        await device!.ppkSetUserGains(4, ug[4]);
    }
    [0, 1, 2, 3, 4].forEach(n =>
        dispatch(updateGainsAction({ value: ug[n] * 100, range: n })),
    );
};

export function checkDigitalTriggerValidity(
    unsignedBits: number,
    prevUnsignedBits: number | undefined,
    channelTriggerStatuses: digitalChannelStateTupleOf8,
    digitalTriggerLogic: DigitalChannelTriggerLogic,
): boolean {
    if (unsignedBits === prevUnsignedBits) return false;

    let hasRelevantChanges = false;
    const result = channelTriggerStatuses
        .map((state, index) => {
            if (state === DigitalChannelTriggerStatesEnum.Off) return null;
            const prevBit = getBit(prevUnsignedBits, index);
            const currBit = getBit(unsignedBits, index);
            const isBitChanged = prevBit === null || prevBit !== currBit;
            if (isBitChanged) hasRelevantChanges = true;

            if (digitalTriggerLogic === 'AND') {
                if (state === DigitalChannelTriggerStatesEnum.High)
                    return currBit === 1;
                if (state === DigitalChannelTriggerStatesEnum.Low)
                    return currBit === 0;
                if (state === DigitalChannelTriggerStatesEnum.Any) return true;
            }

            if (digitalTriggerLogic === 'OR') {
                if (state === DigitalChannelTriggerStatesEnum.High)
                    return currBit === 1 && prevBit === 0;
                if (state === DigitalChannelTriggerStatesEnum.Low)
                    return currBit === 0 && prevBit === 1;
                if (state === DigitalChannelTriggerStatesEnum.Any)
                    return isBitChanged;
            }
            return null;
        })
        .filter(r => r !== null);

    if (!hasRelevantChanges || result.length === 0) return false;

    switch (digitalTriggerLogic) {
        case 'AND':
            return result.every(Boolean);
        case 'OR':
            return result.some(Boolean);
        default:
            return false;
    }
}

const getBit = (value: number | undefined, position: number): number | null => {
    if (value === undefined) return null;
    return (value >> position) & 1;
};

export function checkAnalogTriggerValidity(
    cappedValue: number,
    prevCappedValue: number | undefined,
    triggerLevel: number,
    triggerEdge: TriggerEdge,
): boolean {
    const isRisingEdge = triggerEdge === 'Rising Edge';
    const isLoweringEdge = triggerEdge === 'Falling Edge';

    let validTriggerValue = false;

    if (isRisingEdge) {
        validTriggerValue =
            prevCappedValue != null &&
            prevCappedValue < triggerLevel &&
            cappedValue >= triggerLevel;
    } else if (isLoweringEdge) {
        validTriggerValue =
            prevCappedValue != null &&
            prevCappedValue > triggerLevel &&
            cappedValue <= triggerLevel;
    }
    return validTriggerValue;
}

export const open =
    (deviceInfo: Device): AppThunk<RootState, Promise<void>> =>
    async (dispatch, getState) => {
        // TODO: Check if this is right?
        // Is this suppose to be run when another device is already connected?
        // Seems like it closes old device somewhere else first, meaning this is redundant.
        if (getState().app.app.portName) {
            await dispatch(close());
        }

        let prevValue = 0;
        let prevVoltage = 0;
        let prevCappedValue: number | undefined;
        let prevBits = 0;
        let nbSamples = 0;
        let nbSamplesTotal = 0;
        // samples that arrived in the average being built (DataLogger mode)
        let nbValidInAverage = 0;

        const onSample = ({ value, voltage, bits }: SampleValues) => {
            const state = getState();
            const {
                app: { samplingRunning },
                dataLogger: { maxSampleFreq },
            } = state.app;
            const sampleFreq = getSampleFrequency(state);
            if (!samplingRunning) {
                return;
            }

            // A sample the kit could not deliver has neither current nor
            // voltage. NaN keeps it out of every sum and statistic, and the
            // chart marks it as missing instead of drawing a dip to zero.
            let cappedValue = value ?? NaN;
            // PPK 2 can only read till 200nA (0.2uA)
            if (cappedValue < 0.2) {
                cappedValue = 0;
            }
            let sampleVoltage = voltage ?? NaN;

            const channelTriggerStatuses =
                state.app.trigger.digitalChannelsTriggersStates;
            const unsignedBits = bits !== undefined ? bits & 0xff : 0;
            // Logic levels that were never read stay unknown, not low.
            const b16 = bits !== undefined ? convertBits16(bits) : 0;

            if (samplingRunning && sampleFreq < maxSampleFreq) {
                const samplesPerAverage = maxSampleFreq / sampleFreq;
                nbSamples += 1;
                nbSamplesTotal += 1;
                if (value !== undefined) nbValidInAverage += 1;
                const f = Math.min(nbSamplesTotal, samplesPerAverage);
                if (Number.isFinite(value) && Number.isFinite(prevValue)) {
                    cappedValue = prevValue + (cappedValue - prevValue) / f;
                }
                if (
                    Number.isFinite(sampleVoltage) &&
                    Number.isFinite(prevVoltage)
                ) {
                    sampleVoltage =
                        prevVoltage + (sampleVoltage - prevVoltage) / f;
                }
                if (nbSamples < samplesPerAverage) {
                    if (value !== undefined) {
                        prevValue = cappedValue;
                        prevVoltage = sampleVoltage;
                        prevBits |= b16;
                    }
                    return;
                }
                nbSamples = 0;
                if (value === undefined) {
                    // The average closes on a missing sample: store what the
                    // rest of it gave, or nothing if none of it arrived.
                    cappedValue = nbValidInAverage > 0 ? prevValue : NaN;
                    sampleVoltage = nbValidInAverage > 0 ? prevVoltage : NaN;
                }
                nbValidInAverage = 0;
            }

            DataManager().addData(cappedValue, sampleVoltage, b16 | prevBits);
            prevBits = 0;

            if (getRecordingMode(state) === 'Scope') {
                const triggerCategory = state.app.trigger.category;
                const digitalTriggerLogic =
                    state.app.trigger.digitalChannelsTriggerLogic;

                const validTriggerValue =
                    triggerCategory === 'Analog'
                        ? checkAnalogTriggerValidity(
                              cappedValue,
                              prevCappedValue,
                              state.app.trigger.level,
                              state.app.trigger.edge,
                          )
                        : checkDigitalTriggerValidity(
                              unsignedBits,
                              previousUnsignedBits,
                              channelTriggerStatuses,
                              digitalTriggerLogic,
                          );

                prevCappedValue = cappedValue;
                previousUnsignedBits = unsignedBits;

                if (!DataManager().isInSync()) {
                    return;
                }

                if (!state.app.trigger.active && validTriggerValue) {
                    if (latestTrigger !== undefined) {
                        return;
                    }

                    if (!isSavePending(state)) {
                        dispatch(setSavePending(true));
                    }
                    dispatch(setTriggerActive(true));
                    const offsetLength = getTriggerOffset(getState());
                    const totalRecordingLength =
                        getTriggerRecordingLength(getState()) + offsetLength;
                    dispatch(
                        processTrigger(
                            cappedValue,
                            totalRecordingLength * 1000, // ms to uS
                            offsetLength * 1000,
                            (progressMessage, prog) => {
                                dispatch(
                                    setProgress({
                                        progressMessage,
                                        progress:
                                            prog && prog >= 0
                                                ? prog
                                                : undefined,
                                    }),
                                );
                            },
                        ),
                    ).then(() => {
                        if (!DataManager().hasPendingTriggers()) {
                            dispatch(clearProgress());
                        }
                        if (
                            samplingRunning &&
                            state.app.trigger.type === 'Single'
                        ) {
                            dispatch(samplingStop());
                        }
                    });
                } else if (
                    state.app.trigger.active &&
                    !validTriggerValue &&
                    state.app.trigger.type === 'Continuous'
                ) {
                    dispatch(setTriggerActive(false));
                }
            } else if (!isSavePending(state)) {
                dispatch(setSavePending(true));
            }

            const durationInMicroSeconds =
                convertTimeToSeconds(
                    state.app.dataLogger.duration,
                    state.app.dataLogger.durationUnit,
                ) * microSecondsPerSecond;
            if (durationInMicroSeconds <= DataManager().getTimestamp()) {
                if (samplingRunning) {
                    dispatch(samplingStop());
                }
            }
        };

        try {
            device = new SerialDevice(deviceInfo, onSample);

            dispatch(
                setSamplingAttrsAction({
                    maxContiniousSamplingTimeUs:
                        device.capabilities.maxContinuousSamplingTimeUs!,
                }),
            );

            dispatch(
                setDeviceRunningAction({
                    isRunning: device.isRunningInitially,
                }),
            );
            const metadata = device.parseMeta(await device.start());

            // The firmware reports its own sample rate; the capabilities were
            // set from the default before the metadata was available.
            dispatch(
                setSamplingAttrsAction({
                    maxContiniousSamplingTimeUs:
                        device.capabilities.maxContinuousSamplingTimeUs!,
                }),
            );

            await device.ppkUpdateRegulator(metadata.vdd);
            dispatch(
                updateRegulatorAction({
                    vdd: metadata.vdd,
                    currentVDD: metadata.vdd,
                    ...device.vddRange,
                }),
            );
            await dispatch(initGains());
            dispatch(updateSpikeFilter());
            const isSmuMode = metadata.mode === 2;
            // 1 = Ampere
            // 2 = SMU
            dispatch(setPowerModeAction({ isSmuMode }));
            if (!isSmuMode) dispatch(setDeviceRunning(true));

            dispatch(clearFileLoadedAction());

            logger.info('PPK started');
        } catch (err) {
            logger.error('Failed to start PPK');
            logger.debug(err);
            dispatch({ type: 'device/deselectDevice' });
        }

        dispatch(
            deviceOpenedAction({
                portName: deviceInfo.serialNumber,
                capabilities: device!.capabilities,
            }),
        );

        logger.info('PPK opened');

        device!.on('error', (message, error) => {
            logger.error(message);
            if (error) {
                dispatch(close());
                logger.debug(error);
            }
        });

        clearInterval(updateRequestInterval);
        let renderIndex: number;
        updateRequestInterval = setInterval(
            () => {
                if (Date.now() < integrityLiveUntil) {
                    publishIntegrity(
                        dispatch,
                        getState().app.app.dataIntegrity,
                    );
                }
                if (
                    renderIndex !== DataManager().getTotalSavedRecords() &&
                    getState().app.app.samplingRunning &&
                    isDataLoggerPane(getState())
                ) {
                    const timestamp = Date.now();
                    if (getState().app.chart.liveMode) {
                        requestAnimationFrame(() => {
                            /*
                            requestAnimationFrame pauses when app is in the background.
                            If timestamp is more than 10ms ago, do not dispatch animationAction.
                        */
                            if (Date.now() - timestamp < 100) {
                                dispatch(animationAction());
                            }
                        });
                    }

                    requestAnimationFrame(() => {
                        /*
                        requestAnimationFrame pauses when app is in the background.
                        If timestamp is more than 10ms ago, do not dispatch animationAction.
                    */
                        if (Date.now() - timestamp < 100) {
                            dispatch(miniMapAnimationAction());
                        }
                    });
                    renderIndex = DataManager().getTotalSavedRecords();
                }
            },
            Math.max(30, DataManager().getSamplingTime() / 1000),
        );
    };

export const updateRegulator =
    (): AppThunk<RootState, Promise<void>> => async (dispatch, getState) => {
        const { vdd } = getState().app.voltageRegulator;
        await device!.ppkUpdateRegulator(vdd);
        logger.info(`Voltage regulator updated to ${vdd} mV`);
        dispatch(updateRegulatorAction({ currentVDD: vdd }));
    };

export const updateGains =
    (index: number): AppThunk<RootState, Promise<void>> =>
    async (_, getState) => {
        if (device!.ppkSetUserGains == null) {
            return;
        }
        const { gains } = getState().app;
        const gain = gains[index] / 100;
        await device!.ppkSetUserGains(index, gain);
        logger.info(`Gain multiplier #${index + 1} updated to ${gain}`);
    };

export const updateAllGains =
    (): AppThunk<RootState, Promise<void>> => async (_, getState) => {
        if (device!.ppkSetUserGains == null) {
            return;
        }
        const { gains } = getState().app;

        for (let i = 0; i < gains.length; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            await device!.ppkSetUserGains(i, gains[i] / 100);
            logger.info(`Gain multiplier #${i + 1} updated to ${i}`);
        }
    };

export const setDeviceRunning =
    (isRunning: boolean): AppThunk<RootState, Promise<void>> =>
    async dispatch => {
        await device!.ppkDeviceRunning(isRunning ? 1 : 0);
        logger.info(`DUT ${isRunning ? 'ON' : 'OFF'}`);
        dispatch(setDeviceRunningAction({ isRunning }));
    };

export const setPowerMode =
    (isSmuMode: boolean): AppThunk<RootState, Promise<void>> =>
    async dispatch => {
        logger.info(`Mode: ${isSmuMode ? 'Source meter' : 'Ampere meter'}`);
        if (isSmuMode) {
            await dispatch(setDeviceRunning(false));
            await device!.ppkSetPowerMode(true); // set to source mode
            dispatch(setPowerModeAction({ isSmuMode: true }));
        } else {
            await device!.ppkSetPowerMode(false); // set to ampere mode
            dispatch(setPowerModeAction({ isSmuMode: false }));
            await dispatch(setDeviceRunning(true));
        }
    };

let latestTrigger: Promise<unknown> | undefined;
let releaseLastSession: (() => void) | undefined;

export const processTrigger =
    (
        triggerValue: number,
        triggerLength: number,
        offsetLength: number,
        onProgress?: (message: string, progress?: number) => void,
    ): AppThunk<RootState, Promise<void>> =>
    async (dispatch, getState) => {
        const trigger = DataManager().addTimeReachedTrigger(
            triggerLength,
            offsetLength,
        );

        const triggerTime = Date.now();
        const remainingRecordingLength = triggerLength / 2;

        const updateDataCollection = () => {
            const delta = Date.now() - triggerTime;
            onProgress?.(
                `Triggered with ${unit(triggerValue, 'uA').format({
                    notation: 'fixed',
                    precision: 2,
                })}. Collecting data after trigger.`,
                Math.min(100, (delta / remainingRecordingLength) * 100),
            );
        };

        latestTrigger = trigger;
        const timeProgressUpdate = setInterval(() => {
            updateDataCollection();
        }, 500);

        trigger.finally(() => {
            clearInterval(timeProgressUpdate);
        });

        try {
            const info = await trigger;

            const numberOfBytes =
                info.bytesRange.end - info.bytesRange.start + 1;
            const buffer = Buffer.alloc(numberOfBytes);
            info.writeBuffer.readFromCachedData(
                buffer,
                info.bytesRange.start,
                info.bytesRange.end - info.bytesRange.start + 1,
            );

            const recordingDuration = indexToTimestamp(
                numberOfBytes / frameSize,
            );

            const createSessionData = DataManager().createSessionData;
            const session = await createSessionData(
                buffer,
                getSessionRootFolder(getState()),
                info.absoluteTime,
            );

            dispatch(setTriggerOrigin(indexToTimestamp(info.triggerOrigin)));

            resetCache();
            latestTrigger = undefined;
            // Auto load triggered data
            await DataManager().loadSession(
                session.fileBuffer,
                session.foldingBuffer,
            );
            dispatch(setLatestDataTimestamp(recordingDuration));
            dispatch(chartWindowAction(recordingDuration, recordingDuration));
            dispatch(triggerForceRerenderMainChart());
            dispatch(triggerForceRerenderMiniMap());
            dispatch(miniMapAnimationAction());

            if (session) {
                releaseLastSession?.();
                releaseLastSession = undefined;
                releaseLastSession = async () => {
                    try {
                        await session?.fileBuffer.close();
                        session?.fileBuffer.release();
                    } catch {
                        // do nothing
                    }
                };
            }
        } catch (e) {
            logger.debug(describeError(e));
        }
    };

export const toggleDeviceRunning =
    (): AppThunk<RootState, Promise<void>> => async (dispatch, getState) => {
        const isRunning = getState().app.app.deviceRunning;
        await dispatch(setDeviceRunning(!isRunning));
    };
