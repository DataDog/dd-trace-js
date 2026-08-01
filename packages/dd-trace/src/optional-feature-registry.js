'use strict'

/**
 * @typedef {import('./config/config-base')} Config
 * @typedef {import('./remote_config')} RC
 * @typedef {{ enable: (config: Config) => void, disable: () => void }} OptionalFeatureModule
 * @typedef {{ enable: (rc: RC, config: Config, mod: OptionalFeatureModule) => void }} OptionalFeatureRemoteConfig
 */

/**
 * @typedef {object} OptionalFeature
 * @property {string} name
 * @property {() => OptionalFeatureModule} factory
 * @property {() => OptionalFeatureRemoteConfig} [remoteConfigFactory]
 */

/** @type {{ [name: string]: OptionalFeature }} */
const optionalFeatures = {}

/**
 * @param {OptionalFeature} feature
 */
function registerOptionalFeature (feature) {
  optionalFeatures[feature.name] = feature
}

module.exports = { optionalFeatures, registerOptionalFeature }
