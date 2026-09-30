/*
 * Copyright (c) 2023 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-4-Clause
 */

import { colors } from '@nordicsemiconductor/pc-nrfconnect-shared';
import {
    type Chart,
    type Plugin,
    type ScriptableLineSegmentContext,
} from 'chart.js';

export function isCanvasElement(
    element: EventTarget | null,
): element is HTMLCanvasElement {
    return element instanceof HTMLCanvasElement;
}

// Where samples never arrived from the kit: a trace is drawn across the gap
// in red, over a band that stays visible however far out the chart is
// zoomed. Data points flag it with missing: true.
const missingColor = colors.red;
const missingBandColor = 'rgba(244, 67, 54, 0.15)';
const missingBandMinWidth = 3;

type MaybeMissing = { x?: number; missing?: boolean } | undefined;

/** Line dataset segment options: red wherever either end is missing. */
export const missingSegment = {
    borderColor: (ctx: ScriptableLineSegmentContext) => {
        // The context carries the chart, though its type does not say so.
        const { chart } = ctx as ScriptableLineSegmentContext & {
            chart: Chart;
        };
        const data = chart.data.datasets[ctx.datasetIndex]
            .data as unknown as MaybeMissing[];
        return data[ctx.p0DataIndex]?.missing || data[ctx.p1DataIndex]?.missing
            ? missingColor
            : undefined;
    },
};

/** Shades the stretches the first dataset flags as missing. */
export const missingDataPlugin: Plugin<'line'> = {
    id: 'missingData',
    beforeDatasetsDraw(chart: Chart<'line'>) {
        const points = chart.data.datasets[0]?.data as unknown as
            | MaybeMissing[]
            | undefined;
        if (!points || !points.some(p => p?.missing)) return;

        const {
            ctx,
            chartArea: { top, bottom, left, right },
        } = chart;
        const xScale = chart.scales.xScale ?? chart.scales.x;
        if (!xScale) return;

        const band = (from: number, to: number) => {
            let x0 = xScale.getPixelForValue(from);
            let x1 = xScale.getPixelForValue(to);
            if (x1 - x0 < missingBandMinWidth) {
                const centre = (x0 + x1) / 2;
                x0 = centre - missingBandMinWidth / 2;
                x1 = centre + missingBandMinWidth / 2;
            }
            x0 = Math.max(x0, left);
            x1 = Math.min(x1, right);
            if (x1 > x0) ctx.fillRect(x0, top, x1 - x0, bottom - top);
        };

        ctx.save();
        ctx.fillStyle = missingBandColor;
        // A run of missing points ends where the next complete one starts;
        // the min/max pair of a group shares one x.
        let runStart: number | undefined;
        let lastX: number | undefined;
        points.forEach(p => {
            if (p?.x == null) return;
            if (p.missing) {
                runStart ??= p.x;
            } else if (runStart !== undefined) {
                band(runStart, p.x);
                runStart = undefined;
            }
            lastX = p.x;
        });
        if (runStart !== undefined && lastX !== undefined) {
            band(runStart, lastX);
        }
        ctx.restore();
    },
};
