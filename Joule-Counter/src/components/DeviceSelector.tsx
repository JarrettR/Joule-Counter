/*
 * Copyright (c) 2015 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-4-Clause
 */

import React from 'react';
import { useDispatch } from 'react-redux';
import {
    DeviceSelector,
    type DeviceSetupConfig,
    getAppFile,
    isDeviceInDFUBootloader,
    sdfuDeviceSetup,
} from '@nordicsemiconductor/pc-nrfconnect-shared';

import { close, open } from '../actions/deviceActions';

export const deviceSetupConfig: DeviceSetupConfig = {
    deviceSetups: [
        sdfuDeviceSetup(
            [
                {
                    key: 'ppk2',
                    // Points at the firmware/ (Joule Counter) build. The
                    // semver must match CONFIG_PPK2_DFU_SEMVER so this app
                    // recognizes its own firmware as up to date instead of
                    // offering to overwrite it; anything else on a kit
                    // (stock or baseline/) gets the reprogram prompt.
                    application: getAppFile('firmware/joule_counter_0.2.0.hex'),
                    semver: 'joule_counter 0.2.0',
                    params: {},
                },
            ],
            false,
            d =>
                !isDeviceInDFUBootloader(d) &&
                !!d.serialPorts &&
                d.serialPorts.length > 0 &&
                !!d.traits.nordicUsb &&
                !!d.usb &&
                d.usb.device.descriptor.idProduct === 0xc00a,
        ),
    ],
};

export default () => {
    const dispatch = useDispatch();

    return (
        <DeviceSelector
            deviceSetupConfig={deviceSetupConfig}
            deviceListing={{}} // we have custom filter, so we want all devies from nrfutil to be able to show "No Supported Device Found" instead of "Connect a Nordic Development kit...."
            deviceFilter={device =>
                isDeviceInDFUBootloader(device) ||
                device.usb?.device.descriptor.idProduct === 0xc00a
            }
            onDeviceIsReady={device => {
                dispatch(open(device));
            }}
            onDeviceDeselected={() => {
                dispatch(close());
            }}
        />
    );
};
