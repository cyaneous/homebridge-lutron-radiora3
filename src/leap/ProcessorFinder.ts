import debug from 'debug';
import * as util from 'util';
import { EventEmitter } from 'events';

import ipaddress = require('ip-address');
import dnspacket = require('dns-packet');
import { Protocol, MDNSServiceDiscovery, MDNSService } from 'tinkerhub-mdns';
import TypedEmitter from 'typed-emitter';

import { Processor, LEAP_PORT } from './Processor';

const logDebug = debug('leap:protocol:discovery');

type ProcessorFinderEvents = {
    discovered: (processorNetInfo: ProcessorNetInfo) => void;
    failed: (error: Error) => void;
};

type HostAndPort = {
    host: string;
    port: number;
};

export type ProcessorNetInfo = {
    processorID: string;
    ipAddress: string;
    systype?: string;
};

export class ProcessorFinder extends (EventEmitter as new () => TypedEmitter<ProcessorFinderEvents>) {
    private discovery?: MDNSServiceDiscovery;

    constructor() {
        super();
    }

    public beginSearching() {
        this.discovery = new MDNSServiceDiscovery({
            type: 'lutron',
            protocol: Protocol.TCP,
        });
        this.discovery.onAvailable((svc: MDNSService) => {
            this.handleDiscovery(svc)
                .then((processorNetInfo: ProcessorNetInfo) => {
                    this.emit('discovered', processorNetInfo);
                })
                .catch((e) => {
                    logDebug('failed to handle discovery:', e);
                    this.emit('failed', e);
                });
        });
    }

    private async handleDiscovery(svc: MDNSService): Promise<ProcessorNetInfo> {
        const systype = svc.data.get('systype');
        if (typeof systype === 'boolean') {
            throw new Error(`got boolean systype with value ${systype}`);
        }

        const ipAddress = this.extractIp(svc.addresses);
        logDebug('got useful ipAddress', ipAddress);

        if (!ipAddress) {
            logDebug('thing without useful address:', svc);
            throw new Error('could not get a useful address');
        }

        const processorID = await this.getProcessorID(svc.id);
        logDebug('extracted processor ID:', processorID);

        return {
            processorID: processorID,
            ipAddress: ipAddress,
            systype: systype,
        };
    }

    public destroy(): void {
        if (this.discovery) {
            this.discovery.destroy();
        }
    }

    private extractIp(haps: HostAndPort[]): string | undefined {
        for (const hostandport of haps) {
            logDebug('checking', hostandport);

            // prefer the ipv6 address, but only if it's reachable
            //
            // FIXME: this code is untested in real life, as my home network is
            // ipv4 only.

            const _ip = hostandport.host;
            try {
                const addr = new ipaddress.Address6(_ip);
                if (!addr.isLinkLocal() && !addr.isLoopback()) {
                    // TODO is this sufficient?
                    return _ip;
                    break;
                }
            } catch (e) {
                // try again, but as ipv4
                logDebug('was not ipv6:', e);
                try {
                    const _ = new ipaddress.Address4(_ip);
                    return _ip;
                } catch (e) {
                    // okay, apparently it's some garbage. log it and move on
                    logDebug('could not parse HostAndPort', hostandport, 'because', e);
                }
            }
        }

        return undefined;
    }

    private async getProcessorID(mdnsID: string): Promise<string> {
        // @ts-ignore: reaching into the serviceData private member lets us
        // avoid having to repeat a query for the SRV record. there's no
        // "official" way to get to it, but we can rely on it implicitly
        // existing.
        const tgt: string = this.discovery!.serviceData.get(mdnsID).SRV._record.target;

        try {
            return tgt.match(/[Ll]utron-(?<id>\w+)\.local/)!.groups!.id.toUpperCase();
        } catch (e) {
            throw new Error(`could not get processor serial number from ${tgt}: ${e}`);
        }
    }
}
