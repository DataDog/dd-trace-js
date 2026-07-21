'use strict'

/**
 * @typedef {object} Feature
 * @property {string} name
 * @property {object} noop
 * @property {() => object} factory
 * @property {(config: import('./config/config-base')) => boolean} isEnabled
 * @property {() => Function} provider
 * @property {Function} [remoteConfig]
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
