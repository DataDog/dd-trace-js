'use strict'

const http = require('http')
const https = require('https')
const { storage } = require('../../../../datadog-core')

const legacyStorage = storage('legacy')

const keepAlive = true

/**
 * Creates an agent class that suppresses tracing around socket lifecycle operations.
 *
 * @param {typeof http.Agent|typeof https.Agent} BaseAgent
 * @param {number} maxSockets
 * @returns {typeof http.Agent|typeof https.Agent}
 */
function createAgentClass (BaseAgent, maxSockets) {
  class CustomAgent extends BaseAgent {
    constructor () {
      super({ keepAlive, maxSockets })
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

/**
 * Creates isolated HTTP and HTTPS agents with a bounded connection pool.
 *
 * @param {number} maxSockets
 * @returns {{ httpAgent: http.Agent, httpsAgent: https.Agent }}
 */
function createAgents (maxSockets) {
  const HttpAgent = createAgentClass(http.Agent, maxSockets)
  const HttpsAgent = createAgentClass(https.Agent, maxSockets)

  return {
    httpAgent: new HttpAgent(),
    httpsAgent: new HttpsAgent(),
  }
}

const { httpAgent, httpsAgent } = createAgents(1)

module.exports = {
  createAgents,
  httpAgent,
  httpsAgent,
}
