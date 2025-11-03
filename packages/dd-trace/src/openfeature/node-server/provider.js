'use strict'

const { createExposureEvent, LRUInMemoryAssignmentCache } = require('../flagging-core')
const { OpenFeatureEventEmitter, ProviderEvents } = require('@openfeature/server-sdk')
const { evaluate } = require('./configuration/evaluation')

class DatadogNodeServerProvider {
  constructor(options) {
    this.metadata = {
      name: 'datadog-node-server',
    }
    this.runsOn = 'server'
    this.hooks = []
    this.events = new OpenFeatureEventEmitter()
    this.exposureCache = new LRUInMemoryAssignmentCache(50_000)
    this.options = options
    this.configuration = undefined
    this.resolveInitialization = undefined
    this.rejectInitialization = undefined
  }

  /**
   * Used by dd-source-js
   */
  getConfiguration() {
    return this.configuration
  }

  /**
   * Used by dd-source-js
   */
  setConfiguration(configuration) {
    const prevCreatedAt = this.configuration?.createdAt
    if (this.configuration && this.configuration !== configuration) {
      this.events.emit(ProviderEvents.ConfigurationChanged)
      const newCreatedAt = configuration?.createdAt
      if (prevCreatedAt !== newCreatedAt) {
        this.exposureCache?.clear()
      }
      this.configuration = configuration
      return
    }
    this.configuration = configuration
    if (this.resolveInitialization) {
      this.resolveInitialization()
      this.resolveInitialization = undefined
      this.rejectInitialization = undefined
    }
  }

  /**
   * Used by dd-source-js
   */
  setError(error) {
    if (this.rejectInitialization) {
      this.rejectInitialization(error)
      this.resolveInitialization = undefined
      this.rejectInitialization = undefined
    } else {
      this.events.emit(ProviderEvents.Error, { error })
    }
  }

  /**
   * Used by the OpenFeature SDK to set the status based on initialization.
   * Status of 'PROVIDER_READY' is emitted with a resolved promise.
   * Status of 'PROVIDER_ERROR' is emitted with a rejected promise.
   *
   * Since we aren't loading the configuration in this Provider, we will simulate
   * loading functionality via resolveInitialization and rejectInitialization.
   * See setConfiguration and setError for more details.
   */
  async initialize() {
    if (this.configuration) {
      return
    }
    await new Promise((resolve, reject) => {
      this.resolveInitialization = resolve
      this.rejectInitialization = reject
    })
    await this.exposureCache?.init()
  }

  async resolveBooleanEvaluation(flagKey, defaultValue, context, _logger) {
    const resolutionDetails = evaluate(this.configuration, 'boolean', flagKey, defaultValue, context, _logger)
    this.handleExposure(flagKey, context, resolutionDetails)
    return resolutionDetails
  }

  async resolveStringEvaluation(flagKey, defaultValue, context, _logger) {
    const resolutionDetails = evaluate(this.configuration, 'string', flagKey, defaultValue, context, _logger)
    this.handleExposure(flagKey, context, resolutionDetails)
    return resolutionDetails
  }

  async resolveNumberEvaluation(flagKey, defaultValue, context, _logger) {
    const resolutionDetails = evaluate(this.configuration, 'number', flagKey, defaultValue, context, _logger)
    this.handleExposure(flagKey, context, resolutionDetails)
    return resolutionDetails
  }

  async resolveObjectEvaluation(flagKey, defaultValue, context, _logger) {
    // type safety: OpenFeature interface requires us to return a
    // specific T for *any* value of T (which could be any subtype of
    // JsonValue). We can't even theoretically implement it in a
    // type-sound way because there's no runtime information passed to
    // learn what type the user expects. So it's up to the user to
    // make sure they pass the appropriate type.
    const resolutionDetails = evaluate(
      this.configuration,
      'object',
      flagKey,
      defaultValue,
      context,
      _logger
    )
    this.handleExposure(flagKey, context, resolutionDetails)
    return resolutionDetails
  }

  handleExposure(flagKey, context, resolutionDetails) {
    const timestamp = Date.now()
    const evalutationDetails = {
      ...resolutionDetails,
      flagKey: flagKey,
      flagMetadata: resolutionDetails.flagMetadata ?? {},
    }
    const exposureEvent = createExposureEvent(context, evalutationDetails)
    if (!exposureEvent) {
      return
    }
    const hasLoggedAssignment = this.exposureCache?.has(exposureEvent)
    if (hasLoggedAssignment) {
      return
    }
    if (this.options.exposureChannel.hasSubscribers) {
      this.options.exposureChannel.publish({ ...exposureEvent, timestamp })
      this.exposureCache?.set(exposureEvent)
    }
  }
}

module.exports = {
  DatadogNodeServerProvider
}