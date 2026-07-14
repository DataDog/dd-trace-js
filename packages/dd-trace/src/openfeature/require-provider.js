'use strict'

/**
 * @param {string} request
 * @returns {typeof import('@datadog/openfeature-node-server')}
 */
function requireOptionalPeer (request) {
  // @ts-expect-error webpack exposes this escape hatch as a free variable.
  // eslint-disable-next-line camelcase, no-undef
  if (typeof __non_webpack_require__ === 'function') return __non_webpack_require__(request)
  // eslint-disable-next-line sonarjs/prefer-immediate-return -- nft recognizes this bound-require shape.
  const optionalPeer = require(request)
  return optionalPeer
}

module.exports = requireOptionalPeer('@datadog/openfeature-node-server')
