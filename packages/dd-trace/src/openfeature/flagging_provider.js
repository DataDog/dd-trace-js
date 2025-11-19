'use strict'

const { DatadogNodeServerProvider } = require('@datadog/openfeature-node-server')
const { channel } = require('dc-polyfill')
const log = require('../log')
const { EXPOSURE_CHANNEL } = require('./constants/constants')

/**
 * OpenFeature provider that integrates with Datadog's feature flagging system.
 * Extends DatadogNodeServerProvider to add tracer integration and configuration management.
 */
class FlaggingProvider extends DatadogNodeServerProvider {
  /**
   * @param {import('../tracer')} tracer - Datadog tracer instance
   * @param {import('../config')} config - Tracer configuration object
   */
  constructor (tracer, config) {
    // Call parent constructor with required options
    super({
      exposureChannel: channel(EXPOSURE_CHANNEL)
    })

    this._tracer = tracer
    this._config = config

    log.debug(this.constructor.name + ' created')
  }

  /**
   * Internal method to update flag configuration from Remote Config.
   * This method is called automatically when Remote Config delivers UFC updates.
   *
   * @internal
   * @param {import('@datadog/openfeature-node-server').UniversalFlagConfigurationV1} ufc
   * - Universal Flag Configuration object
   */
  _setConfiguration (ufc) {
    if (typeof this.setConfiguration === 'function') {
      this.setConfiguration(ufc)
    }
    log.debug(this.constructor.name + ' provider configuration updated')
  }
}

module.exports = FlaggingProvider
