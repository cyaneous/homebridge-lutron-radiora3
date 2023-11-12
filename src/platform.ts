import { EventEmitter } from 'events';
import {
    LEAP_PORT,
    LeapClient,
    ProcessorFinder,
    ProcessorNetInfo,
    Processor,
    ProjectDefinition,
    AreaDefinition,
    ControlStationDefinition,
    DeviceDefinition,
    OneDeviceStatus,
    Response,
} from './leap';

import { API, APIEvent, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

import TypedEmitter from 'typed-emitter';

import { PLUGIN_NAME, PLATFORM_NAME } from './settings';
import { SunnataKeypad } from './sunnataKeypad';
import { PicoRemote } from './picoRemote';

type PlatformEvents = {
    unsolicited: (response: Response) => void;
};

// see config.schema.json
export interface GlobalOptions {
    filterPico: boolean;
    clickSpeedLong: 'quick' | 'default' | 'relaxed' | 'disabled';
    clickSpeedDouble: 'quick' | 'default' | 'relaxed' | 'disabled';
}

interface ProcessorAuthEntry {
    processorID: string;
    ca: string;
    key: string;
    cert: string;
}

export enum DeviceWireResultType {
    Success,
    Skipped,
    Error,
}

export type DeviceWireResult = WireSuccess | DeviceSkipped | WireError;

export interface WireSuccess {
    kind: DeviceWireResultType.Success;
    name: string;
}

export interface DeviceSkipped {
    kind: DeviceWireResultType.Skipped;
    reason: string;
}

export interface WireError {
    kind: DeviceWireResultType.Error;
    reason: string;
}

export class LutronRadioRA3Platform
    extends (EventEmitter as new () => TypedEmitter<PlatformEvents>)
    implements DynamicPlatformPlugin {
    private readonly accessories: Map<string, PlatformAccessory> = new Map();
    private finder: ProcessorFinder | null = null;
    private options: GlobalOptions;
    private secrets: Map<string, ProcessorAuthEntry>;
    private processorManager: Map<string, Processor> = new Map();

    constructor(public readonly log: Logging, public readonly config: PlatformConfig, public readonly api: API) {
        super();

        log.info('Lutron RadioRA 3 starting up...');

        this.options = this.optionsFromConfig(config);
        this.secrets = this.secretsFromConfig(config);
        if (this.secrets.size === 0) {
            log.warn('No processor auth configured. Retiring.');
            return;
        }

        // Each device will subscribe to 'unsolicited', which means we very
        // quickly hit the limit for EventEmitters. Set this limit to
        // a very high number (see [#123](https://github.com/thenewwazoo/homebridge-lutron-caseta-leap/issues/123))
        this.setMaxListeners(400 * this.secrets.size);

        /*
         * When this event is fired, homebridge restored all cached accessories from disk and did call their respective
         * `configureAccessory` method for all of them. Dynamic Platform plugins should only register new accessories
         * after this event was fired, in order to ensure they weren't added to homebridge already.
         * This event can also be used to start discovery of new accessories.
         */
        api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
            log.info('Finished launching; starting up automatic discovery');

            this.finder = new ProcessorFinder();
            this.finder.on('discovered', this.handleProcessorDiscovery.bind(this));
            this.finder.on('failed', (error) => {
                log.error('Could not connect to discovered hub:', error);
            });
            this.finder.beginSearching();
        });

        log.info('LutronCasetaLeap plugin finished early initialization');
    }

    optionsFromConfig(config: PlatformConfig): GlobalOptions {
        return Object.assign(
            {
                filterPico: false,
                filterBlinds: false,
                clickSpeedDouble: 'default',
                clickSpeedLong: 'default',
            },
            config.options,
        );
    }

    secretsFromConfig(config: PlatformConfig): Map<string, ProcessorAuthEntry> {
        const out = new Map();
        for (const entry of config.secrets as Array<ProcessorAuthEntry>) {
            out.set(entry.processorID.toLowerCase(), {
                processorID: entry.processorID,
                ca: entry.ca,
                key: entry.key,
                cert: entry.cert,
            });
        }
        return out;
    }

    configureAccessory(accessory: PlatformAccessory): void {
        this.accessories.set(accessory.UUID, accessory);
    }

    private async handleProcessorDiscovery(processorInfo: ProcessorNetInfo) {
        let replaceClient = false;
        const processorID = processorInfo.processorID.toLowerCase();

        if (this.processorManager.has(processorID)) {
            // this is an existing processor re-announcing itself, so we'll recycle the connection to it
            if (this.processorManager.get(processorID)!.processorReconfigInProgress === true){
                this.log.info('Processor', processorInfo.processorID, 'reconfiguration in progress.');
                return;
            }
            this.log.info('Processor', processorInfo.processorID, 'already known, will skip setup.');
            replaceClient = true;
        }

        if (this.secrets.has(processorID)) {
            const these = this.secrets.get(processorID)!;
            this.log.debug('processor', processorInfo.processorID, 'has secrets', JSON.stringify(these));

            const client = new LeapClient(processorInfo.ipAddress, LEAP_PORT, these.ca, these.key, these.cert);

            if (replaceClient) {
                // when we close the client connection, it disconnects, which
                // causes it to emit a disconnection event. this event will
                // propagate to the processor that owns it, which will emit its
                // own disconnect event, triggering re-subscriptions (at the
                // LEAP layer) by buttons and occupancy sensors.
                //
                // I think there's a race here, in that the re-subscription
                // will trigger the client reconnect, possibly before the
                // client object in the processor is replaced. As such, we need to
                // replace the client object with the new client *before* we
                // tell the old client to disconnect. because the processor
                // doesn't tie disconnect events to the client that emitted
                // them (why would it?  processors never have more than one
                // connection), we should then be able to rely on the
                // disconnect event machinery to set things back up for us.
                // convenient!

                // this should, then, look like this:
                //  - store new client in processor
                //  - close old client
                //  - old client emits disconnect
                //  - processor gets disconnect, emits disconnect
                //  - devices ask processor to re-subscribe
                //  - processor uses new client to re-subscribe
                //  - old client goes out of scope
                this.log.info('Processor', processorInfo.processorID, 'entering reconfiguration');
                await this.processorManager.get(processorID)!.reconfigureProcessor(client);
                this.log.info('Processor', processorInfo.processorID, 'exit reconfiguration');
            } else {
                const processor = new Processor(processorID, client);

                // every pico and occupancy sensor needs to subscribe to
                // 'disconnected', and that may be a lot of devices.
                // see [#123](https://github.com/thenewwazoo/homebridge-lutron-caseta-leap/issues/123)
                processor.setMaxListeners(400);

                this.processorManager.set(processor.processorID, processor);
                this.discoverDevices(processor);
            }
        } else {
            this.log.info('no credentials from processor ID', processorInfo.processorID);
        }
    }

    private async discoverDevices(processor: Processor) {
        let project: ProjectDefinition
        try {
            project = await processor.getProject();
        } catch {
            this.log.error('Failed to read the project, aborting discovery for processor', processor.processorID);
            return;
        }

        if (project.ProductType !== 'Lutron RadioRA 3 Project') {
            this.log.error('This is not a RadioRA 3 project, aborting discovery for processor', processor.processorID);
            return;
        }

        this.log.debug('Starting device discovery for processor', processor.processorID);

        let areas: AreaDefinition[];
        try {
            areas = await processor.getAreas();
        } catch {
            this.log.error('Failed to retrieve areas for processor', processor.processorID);
            return;
        }

        for (const area of areas) {
            if (!area.IsLeaf) {
                continue;
            }

            let controlStations: ControlStationDefinition[];
            try {
                controlStations = await processor.getAreaControlStations(area);
            } catch {
                this.log.error('Failed to retrieve control stations for area', area.href); 
                continue;
            }

            for (const controlStation of controlStations) {
                if (controlStation.AssociatedGangedDevices === undefined) {
                    continue;
                }

                for (const gangedDevice of controlStation.AssociatedGangedDevices) {
                    let device: DeviceDefinition;
                    try {
                        device = await processor.getDevice(gangedDevice.Device);
                    } catch {
                        this.log.error('Failed to retrieve ganged device', gangedDevice.Device.href); 
                        continue;
                    }
                    if (device.AddressedState === 'Addressed') {
                        this.processDevice(processor, area, controlStation, device);
                    }
                }
            }
        }

        processor.on('unsolicited', this.handleUnsolicitedMessage.bind(this));
    }

    async processDevice(
        processor: Processor,
        area: AreaDefinition,
        controlStation: ControlStationDefinition,
        device: DeviceDefinition,
    ): Promise<string> {
        const uuid = this.api.hap.uuid.generate(device.SerialNumber.toString());
        const fullyQualifiedName = Array.from(new Set([area.Name, controlStation.Name, device.Name])).join(' ');

        let accessory: PlatformAccessory | undefined = this.accessories.get(uuid);
        let isFromCache = true;
        if (accessory === undefined) {
            isFromCache = false;
            // new device, create an accessory
            this.log.debug(`Device ${fullyQualifiedName} not found in accessory cache`);
            accessory = new this.api.platformAccessory(fullyQualifiedName, uuid);
        }

        const result = await this.wireAccessory(accessory, processor, area, controlStation, device, fullyQualifiedName);
        switch (result.kind) {
            case DeviceWireResultType.Error: {
                if (isFromCache) {
                    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
                    this.log.debug(`un-registered cached device ${fullyQualifiedName} due to an error: ${result.reason}`);
                }
                return Promise.reject(new Error(`Failed to wire device ${fullyQualifiedName}: ${result.reason}`));
            }
            case DeviceWireResultType.Skipped: {
                if (isFromCache) {
                    this.log.debug(`un-registered cached device ${fullyQualifiedName} because it was skipped`);
                    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
                }
                return Promise.resolve(`Skipped setting up device: ${result.reason}`);
            }
            case DeviceWireResultType.Success: {
                if (!isFromCache) {
                    this.accessories.set(accessory.UUID, accessory);
                    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
                    this.log.debug(`registered new device ${fullyQualifiedName} because it was new`);
                }
                return Promise.resolve(`Set up device ${fullyQualifiedName}`);
            }
        }
    }

    async wireAccessory(
        accessory: PlatformAccessory,
        processor: Processor,
        area: AreaDefinition,
        controlStation: ControlStationDefinition,
        device: DeviceDefinition,
        fullyQualifiedName: string,
    ): Promise<DeviceWireResult> {
        accessory.context.device = device;
        accessory.context.processorID = processor.processorID;
        accessory.displayName = fullyQualifiedName;

        switch (device.DeviceType) {
            case 'SunnataKeypad':
            case 'SunnataHybridKeypad': {
                this.log.info(`Found a ${device.DeviceType}: ${fullyQualifiedName}`);
                const keypad = new SunnataKeypad(this, accessory, processor, this.options);
                return keypad.initialize();
            }

            // supported Pico remotes
            case 'Pico2Button':
            case 'Pico2ButtonRaiseLower':
            case 'Pico3Button':
            case 'Pico3ButtonRaiseLower':
            case 'Pico4Button2Group':
            case 'Pico4ButtonScene':
            case 'Pico4ButtonZone':
            case 'PaddleSwitchPico': {
                this.log.info(`Found a ${device.DeviceType} remote ${fullyQualifiedName}`);

                // SIDE EFFECT: this constructor mutates the accessory object
                const remote = new PicoRemote(this, accessory, processor, this.options);
                return remote.initialize();
            }

            // known devices that are not exposed to homekit, pending support
            case 'Pico4Button':
            case 'FourGroupRemote': {
                return Promise.resolve({
                    kind: DeviceWireResultType.Skipped,
                    reason: `Device type ${device.DeviceType} not yet supported, skipping setup. Please file a request ticket`,
                });
            }

            // any device we don't know about yet
            default:
                return Promise.resolve({
                    kind: DeviceWireResultType.Skipped,
                    reason: `Device type ${device.DeviceType} not supported by this plugin`,
                });
        }
    }

    handleUnsolicitedMessage(processorID: string, response: Response) {
        this.log.debug('processor', processorID, 'got unsolicited message', response);

        if (response.CommuniqueType === 'UpdateResponse' && response.Header.Url === '/device/status/deviceheard') {
            const heardDevice = (response.Body! as OneDeviceStatus).DeviceStatus.DeviceHeard;
            this.log.info(`New ${heardDevice.DeviceType} s/n ${heardDevice.SerialNumber}. Triggering refresh in 30s.`);
            const processor = this.processorManager.get(processorID);
            if (processor !== undefined) {
                setTimeout(() => this.discoverDevices(processor), 30000);
            }
        } else {
            this.emit('unsolicited', response);
        }
    }
}
