'use strict'

const { NOOP_REASON } = require('./constants/writers')

class NoopFlaggingProvider {
  constructor (noopTracer) {
    this._tracer = noopTracer
    this._config = {}
    this.metadata = { name: 'NoopFlaggingProvider' }
    this.status = 'NOT_READY'
    this.runsOn = 'server'
  }

  resolveBooleanEvaluation (flagKey, defaultValue, context, logger) {
    return Promise.resolve({
      value: defaultValue,
      reason: NOOP_REASON
    })
  }

  resolveStringEvaluation (flagKey, defaultValue, context, logger) {
    return Promise.resolve({
      value: defaultValue,
      reason: NOOP_REASON
    })
  }

  resolveNumberEvaluation (flagKey, defaultValue, context, logger) {
    return Promise.resolve({
      value: defaultValue,
      reason: NOOP_REASON,
    })
  }

  resolveObjectEvaluation (flagKey, defaultValue, context, logger) {
    return Promise.resolve({
      value: defaultValue,
      reason: NOOP_REASON
    })
  }

  getConfiguration () {
    return this._config
  }

  setConfiguration (config) {
    this._config = config
  }

  _setConfiguration (ufc) {
    this.setConfiguration(ufc)
  }
}

module.exports = NoopFlaggingProvider
