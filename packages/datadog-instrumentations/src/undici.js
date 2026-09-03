'use strict'

const { channel, tracingChannel } = require('dc-polyfill')

const shimmer = require('../../datadog-shimmer')
const satisfies = require('../../../vendor/dist/semifies')
const { addHook } = require('./helpers/instrument')
const { createWrapFetch } = require('./helpers/fetch')

const ch = tracingChannel('apm:undici:fetch')
const upgradeCh = channel('apm:undici:request:upgrade')

// Undici 5.0.x has a bug where fetch doesn't preserve AggregateError in the error cause chain
// Use native DC only for versions where error handling works correctly
const NATIVE_DC_VERSION = '>=4.7.0 <5.0.0 || >=5.1.0'

addHook({
  name: 'undici',
  versions: ['>=4.4.1 <8.0.0', '>=8.0.0'],
  file: 'lib/core/request.js',
}, wrapRequestUpgrade)

addHook({
  name: 'undici',
  versions: ['^4.4.1', '5', '>=6.0.0'],
}, (undici, version) => {
  // For versions with working native DC, let the plugin subscribe directly
  if (satisfies(version, NATIVE_DC_VERSION)) {
    return undici
  }

  // For older versions or those with buggy error handling, wrap fetch
  return shimmer.wrap(undici, 'fetch', createWrapFetch(undici.Request, ch))
})

/**
 * @param {Function & { prototype: Record<string, Function> }} Request
 * @returns {Function}
 */
function wrapRequestUpgrade (Request) {
  const requestSource = Function.prototype.toString.call(Request)
  const methodName = typeof Request.prototype.onRequestUpgrade === 'function'
    ? 'onRequestUpgrade'
    : 'onUpgrade'
  const method = Request.prototype[methodName]

  // Orchestrion cannot leave fixed source byte-for-byte untouched after a conditional AST match.
  if (typeof method !== 'function' ||
      !requestSource.includes('channels.trailers.publish') ||
      Function.prototype.toString.call(method).includes('channels.trailers.publish')) {
    return Request
  }

  shimmer.wrap(Request.prototype, methodName, createWrapUpgrade)
  return Request
}

/**
 * @param {Function} upgrade
 * @returns {Function}
 */
function createWrapUpgrade (upgrade) {
  return function (statusCode, headers, socket) {
    if (!upgradeCh.hasSubscribers) return upgrade.apply(this, arguments)

    const result = upgrade.apply(this, arguments)
    if (!this.aborted) {
      upgradeCh.publish({ headers, request: this, statusCode })
    }
    return result
  }
}
