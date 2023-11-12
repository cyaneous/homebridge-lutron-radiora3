import { Service, PlatformAccessory } from 'homebridge';

import { GlobalOptions, LutronRadioRA3Platform, DeviceWireResult, DeviceWireResultType } from './platform';
import { ButtonTracker } from './buttonTracker';
import { ExceptionDetail, OneButtonStatusEvent, Response, Processor } from './leap';

import { inspect } from 'util';

// This maps DeviceType and ButtonNumber to human-readable labels and
// ServiceLabelIndex values. n.b. the labels are not shown in Apple's Home app,
// but are shown in other apps. The index value determines the order that
// buttons are shown in the Home app. They're ordered top-to-bottom (as they
// appear on the physical remote) in this map.
//
// [
//     $DeviceType,
//     new Map([
//         [$ButtonNumber, { label: '...', index: ... }],
//         ...
//     ]),
// ]
const BUTTON_MAP = new Map<string, Map<number, { label: string; index: number; isUpDown: boolean }>>([
    [
        'Pico2Button',
        new Map([
            [0, { label: 'On', index: 1, isUpDown: false }],
            [2, { label: 'Off', index: 2, isUpDown: false }],
        ]),
    ],
    [
        'Pico2ButtonRaiseLower',
        new Map([
            [0, { label: 'On', index: 1, isUpDown: false }],
            [2, { label: 'Off', index: 4, isUpDown: false }],
            [3, { label: 'Raise', index: 2, isUpDown: true }],
            [4, { label: 'Lower', index: 3, isUpDown: true }],
        ]),
    ],
    [
        'Pico3Button',
        new Map([
            [0, { label: 'On', index: 1, isUpDown: false }],
            [1, { label: 'Center', index: 2, isUpDown: false }],
            [2, { label: 'Off', index: 3, isUpDown: false }],
        ]),
    ],
    [
        'Pico3ButtonRaiseLower',
        new Map([
            [0, { label: 'On', index: 1, isUpDown: false }],
            [1, { label: 'Center', index: 3, isUpDown: false }],
            [2, { label: 'Off', index: 5, isUpDown: false }],
            [3, { label: 'Raise', index: 2, isUpDown: true }],
            [4, { label: 'Lower', index: 4, isUpDown: true }],
        ]),
    ],
    [
        'Pico4Button2Group',
        new Map([
            [1, { label: 'Group 1 On', index: 1, isUpDown: false }],
            [2, { label: 'Group 1 Off', index: 2, isUpDown: false }],
            [3, { label: 'Group 2 On', index: 3, isUpDown: false }],
            [4, { label: 'Group 2 Off', index: 4, isUpDown: false }],
        ]),
    ],
    [
        'Pico4ButtonScene',
        new Map([
            [1, { label: 'Button 1', index: 1, isUpDown: false }],
            [2, { label: 'Button 2', index: 2, isUpDown: false }],
            [3, { label: 'Button 3', index: 3, isUpDown: false }],
            [4, { label: 'Button 4', index: 4, isUpDown: false }],
        ]),
    ],
    [
        'Pico4ButtonZone',
        new Map([
            [1, { label: 'Button 1', index: 1, isUpDown: false }],
            [2, { label: 'Button 2', index: 2, isUpDown: false }],
            [3, { label: 'Button 3', index: 3, isUpDown: false }],
            [4, { label: 'Button 4', index: 4, isUpDown: false }],
        ]),
    ],
    [
        'PaddleSwitchPico',
        new Map([
            [0, { label: 'On', index: 1, isUpDown: false }],
            [2, { label: 'Off', index: 2, isUpDown: false }],
        ]),
    ],
    // TODO
    /*
    ['Pico4Button', new Map([
    ])]
   */
]);

export class PicoRemote {
    private services: Map<string, Service> = new Map();
    private trackers: Map<string, ButtonTracker> = new Map();

    constructor(
        private readonly platform: LutronRadioRA3Platform,
        private readonly accessory: PlatformAccessory,
        private readonly processor: Processor,
        private readonly options: GlobalOptions,
    ) {

    }

    async initialize(): Promise<DeviceWireResult> {
        const fullName = this.accessory.context.device.FullyQualifiedName.join(' ');

        this.accessory
            .getService(this.platform.api.hap.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.api.hap.Characteristic.Manufacturer, 'Lutron Electronics Co., Inc')
            .setCharacteristic(this.platform.api.hap.Characteristic.Model, this.accessory.context.device.ModelNumber)
            .setCharacteristic(
                this.platform.api.hap.Characteristic.SerialNumber,
                this.accessory.context.device.SerialNumber.toString(),
            );

        const labelService =
            this.accessory.getService(this.platform.api.hap.Service.ServiceLabel) ||
            this.accessory.addService(this.platform.api.hap.Service.ServiceLabel);
        labelService.setCharacteristic(
            this.platform.api.hap.Characteristic.ServiceLabelNamespace,
            this.platform.api.hap.Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS, // ha ha
        );

        let buttonGroups;
        try {
            buttonGroups = await this.processor.getDeviceButtonGroupsExpanded(this.accessory.context.device);
        } catch (e) {
            this.platform.log.error('Failed to get button groups belonging to', fullName, e);
            return {
                kind: DeviceWireResultType.Error,
                reason: `Failed to get button groups belonging to ${fullName}: ${e}`,
            };
        }

        buttonGroups.forEach((buttonGroup) => {
            if (buttonGroup instanceof ExceptionDetail) {
                return new Error('Device has been removed');
            }
        });

        for (const buttonGroup of buttonGroups) {
            for (const button of buttonGroup.Buttons) {
                const dentry = BUTTON_MAP.get(this.accessory.context.device.DeviceType);
                if (dentry === undefined) {
                    return {
                        kind: DeviceWireResultType.Error,
                        reason: `Could not find ${this.accessory.context.device.DeviceType} in button map`,
                    };
                }
                const alias = dentry.get(button.ButtonNumber);
                if (alias === undefined) {
                    return {
                        kind: DeviceWireResultType.Error,
                        reason: `Could not find button ${button.ButtonNumber} in ${this.accessory.context.device.DeviceType} map entry`,
                    };
                }

                this.platform.log.debug(
                    `setting up ${button.href} named ${button.Name} numbered ${button.ButtonNumber} as ${inspect(
                        alias,
                        true,
                        null,
                    )}`,
                );

                const service =
                    this.accessory.getServiceById(this.platform.api.hap.Service.StatelessProgrammableSwitch, alias.label) ||
                    this.accessory.addService(
                        this.platform.api.hap.Service.StatelessProgrammableSwitch,
                        button.Name,
                        alias.label,
                    );
                service.addLinkedService(labelService);

                service.setCharacteristic(this.platform.api.hap.Characteristic.Name, alias.label);
                service.setCharacteristic(this.platform.api.hap.Characteristic.ServiceLabelIndex, alias.index);

                service
                    .getCharacteristic(this.platform.api.hap.Characteristic.ProgrammableSwitchEvent)
                    .setProps({ maxValue: 2 });

                this.services.set(button.href, service);
                this.trackers.set(
                    button.href,
                    new ButtonTracker(
                        () =>
                            service
                                .getCharacteristic(this.platform.api.hap.Characteristic.ProgrammableSwitchEvent)
                                .updateValue(this.platform.api.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS),
                        () =>
                            service
                                .getCharacteristic(this.platform.api.hap.Characteristic.ProgrammableSwitchEvent)
                                .updateValue(this.platform.api.hap.Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS),
                        () =>
                            service
                                .getCharacteristic(this.platform.api.hap.Characteristic.ProgrammableSwitchEvent)
                                .updateValue(this.platform.api.hap.Characteristic.ProgrammableSwitchEvent.LONG_PRESS),
                        this.platform.log,
                        button.href,
                        this.options.clickSpeedDouble,
                        this.options.clickSpeedLong,
                        alias.isUpDown,
                    ),
                );

                this.platform.log.debug(`subscribing to ${button.href} events`);
                this.processor.subscribeToButton(button, this.handleEvent.bind(this));

                // when the connection is lost, so are subscriptions.
                this.processor.on('disconnected', () => {
                    this.platform.log.debug(`re-subscribing to ${button.href} events after connection loss`);
                    this.processor.subscribeToButton(button, this.handleEvent.bind(this));
                });
            }
        }

        this.platform.on('unsolicited', this.handleUnsolicited.bind(this));

        return {
            kind: DeviceWireResultType.Success,
            name: fullName,
        };
    }

    handleEvent(response: Response): void {
        const evt = (response.Body! as OneButtonStatusEvent).ButtonStatus;
        const fullName = this.accessory.context.device.FullyQualifiedName.join(' ');
        this.platform.log.info(
            `Button ${evt.Button.href} on Pico remote ${fullName} got action ${evt.ButtonEvent.EventType}`,
        );
        this.trackers.get(evt.Button.href)!.update(evt.ButtonEvent.EventType);
    }

    handleUnsolicited(response: Response): void {
        if (response.Header.MessageBodyType === 'OneButtonStatusEvent') {
            const href = (response.Body as OneButtonStatusEvent)?.ButtonStatus.Button.href;
            if (this.services.has(href)) {
                this.platform.log.warn('got unsolicited response for known button ', href, ', handling anyway');
                this.handleEvent(response);
            }
        }
    }
}
