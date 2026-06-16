'use strict'

/**
 * @typedef {object} Feature
 * @property {string} name
 * @property {object} noop
 * @property {() => object} factory
 * @property {Function} [remoteConfig]
 * @property {Function} [enable]
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
