import debug from 'debug';
import * as retry from 'async-retry';
import { EventEmitter } from 'events';

import { LeapClient } from './LeapClient';
import { Response, ResponseWithTag } from './Messages';
import {
    BodyType,
    ButtonDefinition,
    ButtonGroupDefinition,
    ButtonGroupExpandedDefinition,
    AreaDefinition,
    ControlStationDefinition,
    DeviceDefinition,
    ExceptionDetail,
    Href,
    MultipleAreaDefinition,
    MultipleButtonGroupDefinition,
    MultipleButtonGroupExpandedDefinition,
    MultipleControlStationDefinition,
    MultipleDeviceDefinition,
    OneButtonDefinition,
    OneButtonGroupDefinition,
    OneDeviceDefinition,
    OneZoneStatus,
    MultipleOccupancyGroupStatus,
} from './MessageBodyTypes';

import TypedEmitter from 'typed-emitter';
const logDebug = debug('leap:processor');

export const LEAP_PORT = 8081;
const PING_INTERVAL_MS = 30000;
const PING_TIMEOUT_MS = 5000;
const CONNECT_MAX_RETRY = 20;

export interface ProcessorInfo {
    firmwareRevision: string;
    manufacturer: string;
    model: string;
    name: string;
    serialNumber: string;
}

type ProcessorEvents = {
    unsolicited: (processorID: string, response: Response) => void;
    disconnected: () => void;
};

export class Processor extends (EventEmitter as new () => TypedEmitter<ProcessorEvents>) {
    private pingLooper: ReturnType<typeof setInterval> | null = null;
    public processorReconfigInProgress: boolean;

    constructor(public readonly processorID: string, public client: LeapClient) {
        super();
        logDebug('new processor', processorID, 'being constructed');
        this.processorReconfigInProgress = false;
        client.on('unsolicited', this._handleUnsolicited.bind(this));
        client.on('disconnected', this._handleDisconnect.bind(this));
        this.startPingLoop();
    }

    public async reconfigureProcessor(newClient: LeapClient) {
        this.processorReconfigInProgress = true;
        const oldClient = this.client;
        // close the old client's connections and remove its references to the processor so it can be GC'd
        this.pingLooper = null;
        oldClient.drain();
        // replace the old client with the new
        this.client = newClient;
        this.client.on('unsolicited', this._handleUnsolicited.bind(this));
        this.client.on('disconnected', this._handleDisconnect.bind(this));
        // Make a new connection with the processor, retry to make sure we get connected to it
        // A freshly booted processor will refuses the connection for several seconds
        await retry(
            async () => {
                logDebug('Connecting ...');
                await this.client.connect();
                logDebug('Connected');
            },
            { retries: CONNECT_MAX_RETRY, factor: 1 }
        );
        // Send disconnect signal for re-subscribing
        this.emit('disconnected');
        this.startPingLoop();
        this.processorReconfigInProgress = false;
    }

    private startPingLoop(): void {
        this.pingLooper = setInterval((): void => {
            const pingPromise = this.client.request('ReadRequest', '/server/1/status/ping');
            const timeoutPromise = new Promise((resolve, reject): void => {
                setTimeout((): void => {
                    reject('Ping timeout');
                }, PING_TIMEOUT_MS);
            });

            Promise.race([pingPromise, timeoutPromise])
                .then((resp) => {
                    // if the ping succeeds, there's not really anything to do.
                    logDebug('Ping succeeded', resp);
                })
                .catch((e) => {
                    // if it fails, however, what do we do? the client's
                    // behavior is to attempt to re-open the connection if it's
                    // lost. that means calling `this.client.close()` might
                    // clobber in-flight requests made between the ping timing
                    // out and the attempt to close it. that's bad.
                    //
                    // I think the answer is: nothing. future attempts to use
                    // the client will block (and potentially eventually time
                    // out), and we don't ever want to prevent that happening
                    // unless specifically requested.
                    logDebug('Ping failed:', e);
                });
        }, PING_INTERVAL_MS);
    }

    public start(): void {
        // not much to do here, but it needs to exist if close exists.
        if (this.pingLooper === null) {
            logDebug('Processor starting');
            this.startPingLoop();
        }
    }

    public close(): void {
        // much as with LeapClient.close, this method will not actually prevent
        // some caller from causing the client to reconnect. all this really
        // does is tell the client to close the socket, and kills the
        // keep-alive loop.
        logDebug('processor id', this.processorID, 'closing');
        if (this.pingLooper !== null) {
            clearTimeout(this.pingLooper);
            this.pingLooper = null;
        }
        this.client.close();
    }

    public async ping(): Promise<Response> {
        return await this.client.request('ReadRequest', '/server/1/status/ping');
    }

    public async getHref(href: Href): Promise<BodyType> {
        logDebug(`client getting href ${href.href}`);
        const raw = await this.client.request('ReadRequest', href.href);
        return raw.Body!;
    }

    public async getProcessorInfo(): Promise<ProcessorInfo> {
        logDebug('getting processor information');
        const raw = await this.client.request('ReadRequest', '/device?where=IsThisDevice:true');
        if ((raw.Body! as OneDeviceDefinition).Device) {
            const device = (raw.Body! as OneDeviceDefinition).Device;
            return {
                firmwareRevision: device.FirmwareImage.Firmware.DisplayName,
                manufacturer: 'Lutron Electronics Co., Inc',
                model: device.ModelNumber,
                name: device.Name,
                serialNumber: device.SerialNumber,
            };
        }
        throw new Error('Got bad response to processor info request');
    }

    public async getAreas(): Promise<AreaDefinition[]> {
        logDebug('getting areas');
        const raw = await this.client.request('ReadRequest', '/area');
        if ((raw.Body! as MultipleAreaDefinition).Areas) {
            const areas = (raw.Body! as MultipleAreaDefinition).Areas;
            return areas;
        }
        throw new Error('got bad response to getAreas request');
    }

    public async getAreaControlStations(area: AreaDefinition): Promise<ControlStationDefinition[]> {
        logDebug('getting control stations for area:', area.href);
        const raw = await this.client.request('ReadRequest', area.href + '/associatedcontrolstation');
        if ((raw.Body! as MultipleControlStationDefinition).ControlStations !== undefined) {
            const controlStations = (raw.Body! as MultipleControlStationDefinition).ControlStations;
            return controlStations;
        }
        throw new Error('got bad response to getAreaControlStations request');
    }

    public async getDevice(device: DeviceDefinition): Promise<DeviceDefinition> {
        logDebug('getting device:', device.href);
        const raw = await this.client.request('ReadRequest', device.href);
        if ((raw.Body! as OneDeviceDefinition).Device) {
            const device = (raw.Body! as OneDeviceDefinition).Device;
            return device;
        }
        throw new Error('got bad response to getDevice request');
    }

    public async getDeviceButtonGroups(device: DeviceDefinition): Promise<ButtonGroupDefinition[]> {
        logDebug('getting device button groups:', device.href);
        const raw = await this.client.request('ReadRequest', device.href + '/buttongroup');
        if ((raw.Body! as MultipleButtonGroupDefinition).ButtonGroups) {
            const buttonGroups = (raw.Body! as MultipleButtonGroupDefinition).ButtonGroups;
            return buttonGroups;
        }
        throw new Error('got bad response to getDeviceButtonGroups request');
    }

    // public async getDeviceButtonGroupsExpanded(device: DeviceDefinition): Promise<ButtonGroupExpandedDefinition[]> {
    //     logDebug('getting device button groups expanded:', device.href);
    //     const raw = await this.client.request('ReadRequest', device.href + '/buttongroup/expanded');
    //     if ((raw.Body! as MultipleButtonGroupExpandedDefinition).ButtonGroupsExpanded) {
    //         const buttonGroupsExpanded = (raw.Body! as MultipleButtonGroupExpandedDefinition).ButtonGroupsExpanded;
    //         return buttonGroupsExpanded;
    //     }
    //     throw new Error('got bad response to getDeviceButtonGroupsExpanded request');
    // }

    // public async getDeviceInfo(): Promise<DeviceDefinition[]> {
    //     logDebug('getting info about all devices');
    //     const raw = await this.client.request('ReadRequest', '/device?where=IsThisDevice:true');
    //     if ((raw.Body! as MultipleDeviceDefinition).Devices) {
    //         const devices = (raw.Body! as MultipleDeviceDefinition).Devices;
    //         return devices;
    //     }
    //     throw new Error('got bad response to all device list request');
    // }

    /* A device has a list of ButtonGroup Hrefs. This method maps them to
     * (promises for) the actual ButtonGroup objects themselves.
     */

    // public async getButtonGroupsFromDevice(
    //     device: DeviceDefinition,
    // ): Promise<(ButtonGroupDefinition | ExceptionDetail)[]> {
    //     return Promise.all(
    //         device.ButtonGroups.map((bgHref: Href) =>
    //             this.client.request('ReadRequest', bgHref.href).then((resp: Response) => {
    //                 switch (resp.CommuniqueType) {
    //                     case 'ExceptionResponse':
    //                         return resp.Body! as ExceptionDetail;
    //                     case 'ReadResponse':
    //                         return (resp.Body! as OneButtonGroupDefinition).ButtonGroup;
    //                     default:
    //                         throw new Error('Unexpected communique type');
    //                 }
    //             }),
    //         ),
    //     );
    // }

    /* Similar to getButtonGroupsFromDevice, a ButtonGroup contains a list of
     * Button Hrefs. This maps them to (promises for) the actual Button
     * objects themselves.
     */ 
    public async getButtonsFromGroup(bgroup: ButtonGroupDefinition): Promise<ButtonDefinition[]> {
        return Promise.all(
            bgroup.Buttons.map((button: Href) =>
                this.client
                    .request('ReadRequest', button.href)
                    .then((resp: Response) => (resp.Body! as OneButtonDefinition).Button),
            ),
        );
    }

    public async processCommand(device: DeviceDefinition, command: object): Promise<void> {
        const href = device.LocalZones[0].href + '/commandprocessor';
        //logDebug('setting href', href, 'to value', value);
        this.client.request('CreateRequest', href, {
            Command: command
        });
    }

    public subscribeToButton(button: ButtonDefinition, cb: (r: Response) => void) {
        this.client.subscribe(button.href + '/status/event', cb);
    }

    private _handleUnsolicited(response: Response) {
        logDebug('processor', this.processorID, 'got unsolicited message:');
        logDebug(response);
        this.emit('unsolicited', this.processorID, response);
    }

    private _handleDisconnect(): void {
        // nothing to do here
        logDebug('processor id', this.processorID, 'disconnected.');
        this.emit('disconnected');
    }
}
