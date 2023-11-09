import { API } from 'homebridge';

import { PLATFORM_NAME } from './settings';
import { LutronRadioRA3Platform } from './platform';

export = (api: API) => {
    api.registerPlatform(PLATFORM_NAME, LutronRadioRA3Platform);
};
