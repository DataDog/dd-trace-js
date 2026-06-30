'use strict'

const { rewriteOptionalPeerLoads } = require('../../datadog-instrumentations/src/helpers/optional-peer-bundler')

/**
 * Webpack loader applied to the optional-peer loader files. Rewrites each
 * `requireOptionalPeer('name')` whose peer is installed at build time into a literal
 * `require('name')` so webpack bundles the peer (#8980). Peers that are absent stay opaque, so
 * builds that do not opt into the feature keep the #8635 guarantee.
 *
 * @param {string} source
 * @returns {string}
 */
module.exports = function optionalPeerLoader (source) {
  this.cacheable(false)
  return rewriteOptionalPeerLoads(source, this.context)
}
