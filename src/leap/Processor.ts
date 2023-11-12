import debug from 'debug';
import * as retry from 'async-retry';
import { EventEmitter } from 'events';

import { LeapClient } from './LeapClient';
import { Response, ResponseWithTag } from './Messages';
import {
    BodyType,
    ProjectDefinition,
    ButtonDefinition,
    ButtonGroupExpandedDefinition,
    AreaDefinition,
    ControlStationDefinition,
    DeviceDefinition,
    ExceptionDetail,
    Href,
    MultipleAreaDefinition,
    MultipleButtonGroupExpandedDefinition,
    MultipleControlStationDefinition,
    MultipleDeviceDefinition,
    OneProjectDefinition,
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
        client.on('unsolicited', this.handleUnsolicited.bind(this));
        client.on('disconnected', this.handleDisconnect.bind(this));
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
        this.client.on('unsolicited', this.handleUnsolicited.bind(this));
        this.client.on('disconnected', this.handleDisconnect.bind(this));
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

    public async getProject(): Promise<ProjectDefinition> {
        logDebug('getting project');
        const raw = await this.client.request('ReadRequest', '/project');
        if ((raw.Body! as OneProjectDefinition).Project) {
            return (raw.Body! as OneProjectDefinition).Project;
        }
        throw new Error('Got bad response to getProject() request');
    }

    public async getProcessorInfo(): Promise<DeviceDefinition> {
        logDebug('getting processor information');
        const raw = await this.client.request('ReadRequest', '/device?where=IsThisDevice:true');
        if ((raw.Body! as MultipleDeviceDefinition).Devices.length === 1) {
            return (raw.Body! as MultipleDeviceDefinition).Devices[0];
        }
        throw new Error('Got bad response to getProcessorInfo() request');
    }

    public async getAreas(): Promise<AreaDefinition[]> {
        logDebug('getting areas');
        const raw = await this.client.request('ReadRequest', '/area');
        if ((raw.Body! as MultipleAreaDefinition).Areas) {
            return (raw.Body! as MultipleAreaDefinition).Areas;
        }
        throw new Error('got bad response to getAreas() request');
    }

    public async getAreaControlStations(area: AreaDefinition): Promise<ControlStationDefinition[]> {
        logDebug('getting control stations for area:', area.href);
        const raw = await this.client.request('ReadRequest', area.href + '/associatedcontrolstation');
        if ((raw.Body! as MultipleControlStationDefinition).ControlStations !== undefined) {
            return (raw.Body! as MultipleControlStationDefinition).ControlStations;
        }
        throw new Error('got bad response to getAreaControlStations() request');
    }

    public async getDevice(device: DeviceDefinition): Promise<DeviceDefinition> {
        logDebug('getting device:', device.href);
        const raw = await this.client.request('ReadRequest', device.href);
        if ((raw.Body! as OneDeviceDefinition).Device) {
            return (raw.Body! as OneDeviceDefinition).Device;
        }
        throw new Error('got bad response to getDevice() request');
    }

    public async getDeviceButtonGroupsExpanded(device: DeviceDefinition): Promise<ButtonGroupExpandedDefinition[]> {
        logDebug('getting device button groups expanded:', device.href);
        const raw = await this.client.request('ReadRequest', device.href + '/buttongroup/expanded');
        if ((raw.Body! as MultipleButtonGroupExpandedDefinition).ButtonGroupsExpanded) {
            return (raw.Body! as MultipleButtonGroupExpandedDefinition).ButtonGroupsExpanded;
        }
        throw new Error('got bad response to getDeviceButtonGroupsExpanded() request');
    }

    public async processCommand(device: DeviceDefinition, command: object): Promise<void> {
        logDebug('processing command:', device.href, command);
        const href = device.LocalZones[0].href + '/commandprocessor';
        this.client.request('CreateRequest', href, {
            Command: command
        });
    }

    public subscribeToButton(button: ButtonDefinition, callback: (response: Response) => void) {
        this.client.subscribe(button.href + '/status/event', callback);
    }

    private handleUnsolicited(response: Response) {
        logDebug('processor', this.processorID, 'got unsolicited message:');
        logDebug(response);
        this.emit('unsolicited', this.processorID, response);
    }

    private handleDisconnect(): void {
        // nothing to do here
        logDebug('processor id', this.processorID, 'disconnected.');
        this.emit('disconnected');
    }
}
