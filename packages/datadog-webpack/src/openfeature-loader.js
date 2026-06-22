'use strict'

const { rewriteFlaggingProviderSource } = require('../../datadog-instrumentations/src/helpers/openfeature-bundler')

/**
 * Webpack loader applied to `flagging_provider.js` only when the optional OpenFeature peer
 * resolves at build time. Turns the bundler-opaque peer load into a literal require so
 * webpack bundles the peer, keeping feature flagging working after the bundle is relocated
 * without the peer on disk (#8980). The plugin gates on the peer being installed, so builds
 * that do not opt into feature flagging keep the opaque shape and do not regress #8635.
 *
 * @param {string} source
 * @returns {string}
 */
module.exports = function openFeatureLoader (source) {
  this.cacheable(false)
  return rewriteFlaggingProviderSource(source)
}
