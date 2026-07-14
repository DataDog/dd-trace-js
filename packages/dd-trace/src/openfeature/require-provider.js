'use strict'

/** @type {typeof import('@datadog/openfeature-node-server')} */
let provider

// @ts-expect-error webpack exposes this escape hatch as a free variable.
// eslint-disable-next-line camelcase
if (typeof __non_webpack_require__ === 'function') {
  // eslint-disable-next-line no-undef
  provider = __non_webpack_require__('@datadog/openfeature-node-server')
} else {
  // nft recognizes createRequire through a binding named `module`.
  const module = require('node:module')
  const requireOptionalPeer = module.createRequire(__filename)
  provider = requireOptionalPeer('@datadog/openfeature-node-server')
}

module.exports = provider
