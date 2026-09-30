/*
 * Copyright (c) 2022 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-4-Clause
 */

/** What went missing from a stream, and why, since it started. */
export interface StreamIntegrity {
    /** samples the kit took that never reached the app */
    lostSamples: number;
    /** separate stretches of lost samples */
    gaps: number;
    /** gaps the kit reported as its own buffer overflowing: the samples
     * were not read out fast enough */
    kitOverflows: number;
    /** blocks rejected for a bad CRC */
    crcErrors: number;
    /** sample period the counts refer to, µs */
    samplingTimeUs: number;
}

export interface SampleValues {
    /** current, µA */
    value?: number;
    /** DUT voltage, V */
    voltage?: number;
    bits?: number;
    endOfTrigger?: boolean;
}

export interface Modifiers {
    r: modifier;
    gs: modifier;
    gi: modifier;
    o: modifier;
    s: modifier;
    i: modifier;
    ug: modifier;
}
export type modifier = [number, number, number, number, number];
export type modifiers = {
    [Property in keyof Modifiers]: modifier;
};

export interface openingMessage {
    opening: string;
}

export interface startedMessage {
    started: string;
}

export interface bufferMessage {
    type: string;
    data: Array<number>;
}

export interface errorMessage {
    error: string;
}

export type serialDeviceMessage =
    | openingMessage
    | startedMessage
    | bufferMessage
    | errorMessage
    | Uint8Array;
