import { Service, PlatformAccessory } from 'homebridge';

import { GlobalOptions, LutronRadioRA3Platform, DeviceWireResult, DeviceWireResultType } from './platform';
import { ButtonTracker } from './ButtonTracker';
import { ExceptionDetail, OneButtonStatusEvent, Response, Processor, ButtonDefinition } from './leap';

import { inspect } from 'util';

export class SunnataKeypad {
    private services: Map<string, Service> = new Map();
    private trackers: Map<string, ButtonTracker> = new Map();

    constructor(
        private readonly platform: LutronRadioRA3Platform,
        private readonly accessory: PlatformAccessory,
        private readonly processor: Processor,
        private readonly options: GlobalOptions,
    ) {}

    public async initialize(): Promise<DeviceWireResult> {
        const fullName = this.accessory.context.device.Name;

        this.accessory
            .getService(this.platform.api.hap.Service.AccessoryInformation)!
            .setCharacteristic(this.platform.api.hap.Characteristic.Manufacturer, 'Lutron Electronics Co., Inc')
            .setCharacteristic(this.platform.api.hap.Characteristic.Model, this.accessory.context.device.ModelNumber)
            .setCharacteristic(
                this.platform.api.hap.Characteristic.SerialNumber,
                this.accessory.context.device.SerialNumber.toString(),
            );

        const label_svc =
            this.accessory.getService(this.platform.api.hap.Service.ServiceLabel) ||
            this.accessory.addService(this.platform.api.hap.Service.ServiceLabel);
        label_svc.setCharacteristic(
            this.platform.api.hap.Characteristic.ServiceLabelNamespace,
            this.platform.api.hap.Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS,
        );

        let bgs;
        try {
            bgs = await this.processor.getDeviceButtonGroups(this.accessory.context.device);
        } catch (e) {
            this.platform.log.error('Failed to get button groups belonging to', fullName, e);
            return {
                kind: DeviceWireResultType.Error,
                reason: `Failed to get button groups belonging to ${fullName}: ${e}`,
            };
        }

        bgs.forEach((bg) => {
            if (bg instanceof ExceptionDetail) {
                return new Error('Device has been removed');
            }
        });

        let buttons: ButtonDefinition[] = [];
        for (const bg of bgs) {
            try {
                buttons = buttons.concat(await this.processor.getButtonsFromGroup(bg));
            } catch (e) {
                this.platform.log.error('Failed to get buttons from button group', bg.href);
                return {
                    kind: DeviceWireResultType.Error,
                    reason: `Failed to get buttons from button group ${bg.href}: ${e}`,
                };
            }
        }

        for (const button of buttons) {
            const label = button.Engraving.Text || button.Name;

            this.platform.log.info(`setting up ${button.href} named ${label} numbered ${button.ButtonNumber}`);

            const service =
                this.accessory.getServiceById(this.platform.api.hap.Service.StatelessProgrammableSwitch, button.Name) ||
                this.accessory.addService(
                    this.platform.api.hap.Service.StatelessProgrammableSwitch,
                    label,
                    button.Name,
                );
            service.addLinkedService(label_svc);

            service.setCharacteristic(this.platform.api.hap.Characteristic.Name, label);
            service.setCharacteristic(this.platform.api.hap.Characteristic.ServiceLabelIndex, button.ButtonNumber);

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
                    false
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

        this.platform.on('unsolicited', this.handleUnsolicited.bind(this));

        return {
            kind: DeviceWireResultType.Success,
            name: fullName,
        };
    }

    handleEvent(response: Response): void {
        const evt = (response.Body! as OneButtonStatusEvent).ButtonStatus;
        const fullName = this.accessory.context.device.Name;
        this.platform.log.info(
            `Button ${evt.Button.href} on keypad ${fullName} got action ${evt.ButtonEvent.EventType}`,
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
