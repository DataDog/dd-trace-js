'use strict'

const EventPlugin = require('./event')

// Params captured on the instrumentation context that are safe to forward as pprof labels. Must be
// a subset of the names declared in asyncParamsByMethod in datadog-instrumentations/src/crypto.js.
const allowedParams = new Set([
  'algorithm', 'digest', 'iterations', 'keylen', 'offset', 'operation', 'size', 'type',
])

class CryptoPlugin extends EventPlugin {
  static id = 'crypto'

  static operation = 'operation'

  static entryType = 'crypto'

  extendEvent (event, ctx) {
    const detail = {}
    for (const name of allowedParams) {
      const value = ctx[name]
      if (typeof value === 'string' || typeof value === 'number') {
        detail[name] = value
      }
    }
    event.detail = detail

    return event
  }
}

module.exports = CryptoPlugin
