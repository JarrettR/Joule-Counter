/*
 * Copyright (c) 2015 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-4-Clause
 */

import { colors } from '@nordicsemiconductor/pc-nrfconnect-shared';
import { type Plugin } from 'chart.js';

import type { AmpereChartJS } from '../AmpereChart';
import type { AmpereState } from '../data/dataTypes';

const { gray700: color, white } = colors;
const labelHeight = 20;
const labelGap = 2;
const markerRadius = 3;
// Space between the cursor line and the time and value labels
const labelOffset = 15;

// Finds the point covering time t: the last one at or before it, as long as
// t is not past the end of the data by more than one point spacing.
const pointAt = (data: AmpereState[], t: number) => {
    let lo = 0;
    let hi = data.length - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const x = data[mid]?.x;
        if (x != null && x <= t) {
            found = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    const point = data[found];
    if (point?.x == null) return undefined;

    if (found === data.length - 1) {
        const prevX = data[found - 1]?.x;
        if (prevX == null || t - point.x > point.x - prevX) return undefined;
    }
    return point;
};

interface CrossHairPlugin extends Plugin<'line'> {
    instances: AmpereChartJS[];
    moveEvent: null | {
        offsetX: number;
        offsetY: number;
        drawY: boolean;
    };
    pointerMoveHandler: (event: PointerEvent, chart: AmpereChartJS) => void;
    pointerLeaveHandler: () => void;
    handlerRegistry: Map<
        AmpereChartJS,
        {
            pointerMoveListener: (event: PointerEvent) => void;
            pointerLeaveListener: () => void;
        }
    >;
}

const plugin: CrossHairPlugin = {
    id: 'crossHair',
    instances: [],
    moveEvent: null,
    handlerRegistry: new Map(),

    pointerMoveHandler(event, chart) {
        const {
            chartArea: { left },
            options: { snapping, live },
            config: {
                options: { id },
            },
        } = chart;

        if (live) {
            plugin.moveEvent = null;
            return;
        }

        const { offsetY } = event;
        let { offsetX } = event;

        const drawY = id === 'ampereChart';

        if (snapping) {
            // Snap by time only: an x/y distance would pick whichever point
            // is closest to the mouse height when hovering off the trace.
            // Points clipped by the Y range still count.
            const hit = chart.getElementsAtEventForMode(
                event,
                'nearest',
                { axis: 'x', intersect: false, includeInvisible: true },
                true,
            )[0];
            if (hit) {
                offsetX = hit.element.x;
            }
        }
        plugin.moveEvent = { offsetX: offsetX - left, offsetY, drawY };
        plugin.instances.forEach(instance => instance.update('none'));
    },

    pointerLeaveHandler() {
        plugin.moveEvent = null;
        plugin.instances.forEach(instance => instance.update('none'));
    },

    beforeInit(chart: AmpereChartJS) {
        plugin.instances.push(chart);

        const { canvas } = chart.ctx;
        const pointerMoveListener = (event: PointerEvent) =>
            plugin.pointerMoveHandler(event, chart);
        const pointerLeaveListener = () => plugin.pointerLeaveHandler();

        canvas.addEventListener('pointermove', pointerMoveListener);
        canvas.addEventListener('pointerleave', pointerLeaveListener);

        plugin.handlerRegistry.set(chart, {
            pointerMoveListener,
            pointerLeaveListener,
        });
    },

    afterDraw(chart: AmpereChartJS) {
        const {
            ctx,
            chartArea: { left, right, top, bottom },
            scales,
            config: {
                options: { formatX, crossHairValues },
            },
        } = chart;
        const { xScale } = scales;
        const { canvas } = ctx;

        if (!plugin.moveEvent) {
            canvas.style.cursor = 'default';
            return;
        }

        const { offsetX, offsetY, drawY } = plugin.moveEvent;
        const x = Math.ceil(offsetX - 0.5) - 0.5;
        const lineX = left + offsetX;

        const inY = offsetY >= top && offsetY <= bottom;
        canvas.style.cursor = inY ? 'pointer' : 'default';

        if (offsetX < 0 || offsetX > right - left) return;

        const t = xScale.getValueForPixel(lineX);
        if (t == null) return;

        // Each visible trace is read at the cursor time: a marker on the
        // trace, and a label in its colour stacked below the time label.
        const readouts =
            inY && drawY && crossHairValues != null
                ? crossHairValues.flatMap(
                      ({ data, scaleId, format, color: bg, visible }) => {
                          const scale = scales[scaleId];
                          if (!visible || scale == null) return [];
                          const point = pointAt(data, t);
                          if (point?.y == null || Number.isNaN(point.y)) {
                              return [];
                          }
                          return [
                              {
                                  text: format(point.y),
                                  bg,
                                  markerY: scale.getPixelForValue(point.y),
                              },
                          ];
                      },
                  )
                : [];
        const timeLabel =
            chart.height > 32 && formatX != null ? formatX(t) : undefined;

        ctx.save();
        ctx.lineWidth = 0.5;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(left + x, top);
        ctx.lineTo(left + x, bottom);
        ctx.closePath();
        ctx.stroke();

        const timeWidth =
            timeLabel != null ? ctx.measureText(timeLabel[0]).width + 10 : 0;
        const boxWidth = Math.max(
            0,
            ...readouts.map(({ text }) => ctx.measureText(text).width + 10),
        );
        // All labels sit on one side of the cursor line, flipping to the
        // left together rather than run off the chart.
        const flip =
            lineX + labelOffset + Math.max(timeWidth, boxWidth) > right;
        const labelLeft = (width: number) =>
            flip ? lineX - labelOffset - width : lineX + labelOffset;

        if (timeLabel != null) {
            const [time, subsecond] = timeLabel;
            const tsLeft = labelLeft(timeWidth);
            ctx.fillStyle = color;
            ctx.fillRect(tsLeft, top, timeWidth, 33);
            ctx.fillStyle = white;
            ctx.textAlign = 'center';
            ctx.fillText(time, tsLeft + timeWidth / 2, top + 13);
            ctx.fillText(subsecond, tsLeft + timeWidth / 2, top + 28);
        }

        const boxLeft = labelLeft(boxWidth);
        let boxTop = top + 33 + labelGap;

        ctx.textAlign = 'left';
        readouts.forEach(({ text, bg, markerY }) => {
            if (markerY >= top && markerY <= bottom) {
                ctx.fillStyle = bg;
                ctx.beginPath();
                ctx.arc(left + x, markerY, markerRadius, 0, 2 * Math.PI);
                ctx.fill();
            }

            ctx.fillStyle = bg;
            ctx.fillRect(boxLeft, boxTop, boxWidth, labelHeight);
            ctx.fillStyle = white;
            ctx.fillText(text, boxLeft + 5, boxTop + 13);
            boxTop += labelHeight + labelGap;
        });

        ctx.restore();
    },

    afterDestroy(chartInstance) {
        const i = plugin.instances.findIndex(
            ({ id }) => id === chartInstance.id,
        );
        if (i > -1) {
            plugin.instances.splice(i, 1);
        }

        const chart = chartInstance as AmpereChartJS;
        const handlers = plugin.handlerRegistry.get(chart);
        if (handlers) {
            const canvas = chart?.ctx?.canvas;

            if (canvas) {
                canvas.removeEventListener(
                    'pointermove',
                    handlers.pointerMoveListener,
                );
                canvas.removeEventListener(
                    'pointerleave',
                    handlers.pointerLeaveListener,
                );
            }

            plugin.handlerRegistry.delete(chart);
        }
    },
};

export default plugin;
