'use strict'

/**
 * @typedef {{ enable: (config: import('./config/config-base')) => void, disable: () => void }} FeatureModule
 * @typedef {new (tracer: import('./tracer'), config: import('./config/config-base')) => object} FeatureProvider
 */

/**
 * @typedef {object} Feature
 * @property {string} name
 * @property {object} noop
 * @property {() => FeatureModule} factory
 * @property {(config: import('./config/config-base')) => boolean} isEnabled
 * @property {() => FeatureProvider} provider
 * @property {(rc: import('./remote_config'), config: import('./config/config-base'),
 *   proxy: import('./proxy')) => void} [remoteConfig]
 */

/** @type {{ [name: string]: Feature }} */
const features = {}

/**
 * @param {Feature} feature
 */
function registerFeature (feature) {
  features[feature.name] = feature
}

module.exports = { features, registerFeature }
