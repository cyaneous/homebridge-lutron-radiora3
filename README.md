# LutronRadioRA3

This plugin adds RadioRA 3 support to HomeBridge/HomeKit.

It currently supports:

* Sunnata Keypads
* Sunnata Hybrid Keypads

If you would like to see other devices added, let me know. Because HomeKit control for dimmers and switches, etc, are natively supported by the Smart Bridge, this plugin doesn't implement them.

This project is based on [lutron-leap-js](https://github.com/thenewwazoo/lutron-leap-js) and [homebridge-lutron-caseta-leap](https://github.com/thenewwazoo/homebridge-lutron-caseta-leap/). To provide optimal RadioRA 3 support, I have decided to make it a separate piece of code.

## Development setup

(rough notes)

* Check this out
* Check out the lutron-leap-js repo
* Make changes there and `npm run build` it
* `npm install ../lutron-leap-js`
* Make changes here
* `rm ~/.homebridge/accessories/cachedAccessories; DEBUG='leap:*,HAP-NodeJS:Accessory' npm run watch`
* `npm run lint`

