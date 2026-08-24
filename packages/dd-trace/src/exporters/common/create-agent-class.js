'use strict'

const { storage } = require('../../../../datadog-core')

const legacyStorage = storage('legacy')

/**
 * Creates an agent class whose socket lifecycle cannot be traced.
 *
 * @param {typeof import('node:http').Agent|typeof import('node:https').Agent} BaseAgent
 * @param {number} maxSockets
 * @returns {typeof import('node:http').Agent|typeof import('node:https').Agent}
 */
function createAgentClass (BaseAgent, maxSockets) {
  class CustomAgent extends BaseAgent {
    /**
     * Creates an HTTP agent with bounded socket concurrency.
     */
    constructor () {
      super({ keepAlive: true, maxSockets })
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

  return CustomAgent
}

module.exports = createAgentClass
