'use strict'

const http = require('http')
const https = require('https')
const { storage } = require('../../../../datadog-core')

const legacyStorage = storage('legacy')

/**
 * Creates an exporter agent class that suppresses tracing around socket lifecycle operations.
 *
 * @param {typeof http.Agent|typeof https.Agent} BaseAgent
 * @param {number} maxSockets
 * @returns {typeof http.Agent|typeof https.Agent}
 */
function createAgentClass (BaseAgent, maxSockets) {
  class CustomAgent extends BaseAgent {
    constructor () {
      super({ keepAlive: true, maxSockets })
    }

    createConnection (...args) {
      return this._noop(() => super.createConnection(...args))
    }

    keepSocketAlive (...args) {
      return this._noop(() => super.keepSocketAlive(...args))
    }

    reuseSocket (...args) {
      return this._noop(() => super.reuseSocket(...args))
    }

    _noop (callback) {
      return legacyStorage.run({ noop: true }, callback)
    }
  }

  return CustomAgent
}

const HttpAgent = createAgentClass(http.Agent, 1)
const HttpsAgent = createAgentClass(https.Agent, 1)

module.exports = {
  createAgentClass,
  httpAgent: new HttpAgent(),
  httpsAgent: new HttpsAgent(),
}
