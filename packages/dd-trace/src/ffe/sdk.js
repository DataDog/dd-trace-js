'use strict'

const { DatadogNodeServerProvider } = require('@datadog/openfeature-node-server')
const { channel } = require('dc-polyfill')
const log = require('../log')
const { EXPOSURE_CHANNEL } = require('./constants/constants')

class FlaggingProvider extends DatadogNodeServerProvider {
  constructor (tracer, config) {
    // Call parent constructor with required options
    super({
      exposureChannel: channel(EXPOSURE_CHANNEL)
    })

    this._tracer = tracer
    this._config = config

    log.debug('[FlaggingProvider] Created')
  }

  _setConfiguration (ufc) {
    if (typeof this.setConfiguration === 'function') {
      this.setConfiguration(ufc)
    }
    log.debug('[FlaggingProvider] Provider configuration updated')
  }
}

module.exports = FlaggingProvider
