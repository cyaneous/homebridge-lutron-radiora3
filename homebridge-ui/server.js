const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const { ProcessorFinder, LeapClient, PairingClient } = require('lutron-leap');

const forge = require('node-forge');

class PluginUiServer extends HomebridgePluginUiServer {
    constructor() {
        // super() MUST be called first
        super();

        this.finder = new ProcessorFinder();
        this.finder.on('discovered', (processorNetInfo) => {
            this.pushEvent('discovered', processorNetInfo);
        });

        this.onRequest('/search', this.findProcessors.bind(this));
        this.onRequest('/connect', this.doConnect.bind(this));
        this.onRequest('/associate', this.doAssociate.bind(this));

        // this MUST be called when you are ready to accept requests
        this.ready();
    }

    async findProcessors() {
        this.finder.beginSearching();
    }

    async doConnect({ secrets, processorID, ipAddress }) {
        console.log('Got request to connect', processorID, 'at', ipAddress, ' with secrets', JSON.stringify(secrets));
        try {
            const client = new LeapClient(ipAddress, 8081 /*TODO magic number*/, secrets.ca, secrets.key, secrets.cert);
            await client.connect();
            console.log('client connected to', processorID, ipAddress);
            // TODO actually do a ping here, maybe return LEAP version?
        } catch (e) {
            console.log('failed to connect to', processorID, e);
            this.pushEvent('failed', { processorID: processorID, reason: e.message });
            throw e;
        }
        this.pushEvent('connected', processorID);
    }

    async doAssociate({ processorID, ipAddress }) {
        /***
         * This is kind of a long, ugly one. Here's what this does:
         * - Creates a new PairingClient w/ some default SSL credentials
         * - Waits for a special kind of message to come down the wire that indicates
         *   that the button has been pressed.
         * - Generate a new RSA keypair
         * - Create a certification signing request (PKCS#10)
         * - Submit it to the processor and wait for a special kind of response
         *   that includes the signed certificate
         * - Return the newly-generated privkey, cert, and CA to the UI
         ***/

        // Create a new pairing client w/ some default SSL credentials
        console.log('Got request to associate with', processorID, 'at', ipAddress);
        const client = new PairingClient(ipAddress, 8083 /*TODO magic number*/);
        try {
            await client.connect();
            console.log('association phase connected', processorID, ipAddress);
        } catch (e) {
            console.log('failed to associate', processorID, ipAddress, e);
            throw new Error('Initial associate failed!');
        }

        // Wait for a special kind of message to come down the wire that
        // indicates that the button has been pressed.
        try {
            await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('timed out')), 30000);
                client.once('message', (response) => {
                    console.log('got message', response);
                    if (response.Body.Status.Permissions.includes('PhysicalAccess')) {
                        console.log('Physical access confirmed');
                        clearTimeout(t);
                        resolve();
                    } else {
                        console.log('unexpected pairing result', response);
                        reject(response);
                    }
                });
            });
        } catch (e) {
            console.log('waiting for button push failed', e);
            throw e;
        }

        // Generate a new RSA keypair
        const keys = await new Promise((resolve, reject) => {
            forge.pki.rsa.generateKeyPair({ bits: 2048 }, (err, keyPair) => {
                if (err !== undefined) {
                    resolve(keyPair);
                } else {
                    reject(err);
                }
            });
        });

        // Create a certification signing request (PKCS#10)
        const csr = forge.pki.createCertificationRequest();
        csr.publicKey = keys.publicKey;
        csr.setSubject([
            {
                name: 'commonName',
                value: 'homebridge-lutron-radiora3',
            },
        ]);
        csr.sign(keys.privateKey);
        const csrText = forge.pki.certificationRequestToPem(csr);

        // Submit it to the processor and wait for a special kind of response that
        // includes the signed certificate
        let certResult;
        try {
            certResult = await new Promise((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('CSR response timed out')), 5000);
                client.once('message', (response) => {
                    console.log('got cert request result', JSON.stringify(response));
                    resolve(response);
                });

                client.requestPair(csrText);
            });

            if (certResult.Header.StatusCode !== '200 OK') {
                throw new Error('bad CSR response: ' + JSON.stringify(certResult));
            }
        } catch (e) {
            console.log('CSR failed', e);
            throw e;
        }

        // Return the newly-generated privkey, cert, and CA to the UI
        this.pushEvent('associated', {
            processorID: processorID,
            ipAddress: ipAddress,
            secrets: {
                processorID: processorID,
                ca: certResult.Body.SigningResult.RootCertificate,
                cert: certResult.Body.SigningResult.Certificate,
                key: forge.pki.privateKeyToPem(keys.privateKey),
            },
        });
    }
}

(() => {
    return new PluginUiServer();
})();
