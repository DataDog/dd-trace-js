'use strict'

const http = require('node:http')
const https = require('node:https')

const { storage } = require('../../../../datadog-core')

const legacyStorage = storage('legacy')
const options = { keepAlive: true, maxSockets: 8 }

// These hooks intentionally mirror exporters/common/agents.js. Keeping the implementation local
// lets Test Optimization use independent connection limits without modifying agents shared by other products.
// Keep the context-suppressed socket lifecycle aligned with the common implementation.
/**
 * Creates a Test Optimization agent class whose socket lifecycle cannot be traced.
 *
 * @param {typeof http.Agent|typeof https.Agent} BaseAgent
 * @returns {typeof http.Agent|typeof https.Agent}
 */
function createAgentClass (BaseAgent) {
  class TestOptimizationAgent extends BaseAgent {
    /**
     * Creates a Test Optimization HTTP agent.
     */
    constructor () {
      super(options)
    }

    /**
     * Creates a socket outside the active trace context.
     *
     * @param {...unknown} args
     * @returns {import('node:stream').Duplex}
     */
    createConnection (...args) {
      return this._noop(() => super.createConnection(...args))
    }

    /**
     * Keeps an idle socket alive outside the active trace context.
     *
     * @param {...unknown} args
     * @returns {boolean}
     */
    keepSocketAlive (...args) {
      return this._noop(() => super.keepSocketAlive(...args))
    }

    /**
     * Reuses a socket outside the active trace context.
     *
     * @param {...unknown} args
     * @returns {void}
     */
    reuseSocket (...args) {
      return this._noop(() => super.reuseSocket(...args))
    }

    /**
     * Runs a socket operation without generating tracer telemetry.
     *
     * @template T
     * @param {() => T} callback
     * @returns {T}
     */
    _noop (callback) {
      return legacyStorage.run({ noop: true }, callback)
    }
  }

  return TestOptimizationAgent
}

const HttpAgent = createAgentClass(http.Agent)
const HttpsAgent = createAgentClass(https.Agent)

const httpAgent = new HttpAgent()
const httpsAgent = new HttpsAgent()

/**
 * Selects the dedicated Test Optimization agent for an intake URL.
 *
 * @param {string|URL|object} url
 * @returns {http.Agent|https.Agent}
 */
function getAgent (url) {
  const isSecure = typeof url === 'string' ? url.startsWith('https:') : url?.protocol === 'https:'
  return isSecure ? httpsAgent : httpAgent
}

module.exports = { getAgent }
