'use strict'

/** @type {(request: string) => typeof import('@datadog/openfeature-node-server')} */
let requireOptionalPeer

// @ts-expect-error webpack exposes this escape hatch as a free variable.
// eslint-disable-next-line camelcase
if (typeof __non_webpack_require__ === 'function') {
  // eslint-disable-next-line camelcase, no-undef
  requireOptionalPeer = __non_webpack_require__
} else {
  // nft recognizes createRequire through a binding named `module`.
  const module = require('node:module')
  const runtimeRequire = module.createRequire(__filename)
  requireOptionalPeer = runtimeRequire
}

module.exports = requireOptionalPeer('@datadog/openfeature-node-server')
