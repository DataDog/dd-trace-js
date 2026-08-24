'use strict'

const http = require('http')
const https = require('https')
const { storage } = require('../../../../datadog-core')

const legacyStorage = storage('legacy')

const keepAlive = true
const maxSockets = 1

/**
 * Creates an HTTP agent whose socket lifecycle runs outside the active trace context.
 *
 * @param {typeof http.Agent|typeof https.Agent} BaseAgent
 * @param {http.AgentOptions|https.AgentOptions} options
 * @returns {http.Agent|https.Agent}
 */
function createAgent (BaseAgent, options) {
  class CustomAgent extends BaseAgent {
    constructor () {
      super(options)
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

  return new CustomAgent()
}

const options = { keepAlive, maxSockets }

module.exports = {
  createAgent,
  httpAgent: createAgent(http.Agent, options),
  httpsAgent: createAgent(https.Agent, options),
}
