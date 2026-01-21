'use strict'

const NoopAppsecSdk = require('../appsec/sdk/noop')
const NoopLLMObsSDK = require('../llmobs/noop')
const NoopFlaggingProvider = require('../openfeature/noop')
const NoopAIGuardSDK = require('../aiguard/noop')
const NoopDogStatsDClient = require('./dogstatsd')
const NoopTracer = require('./tracer')

const noop = new NoopTracer()
const noopAppsec = new NoopAppsecSdk()
const noopDogStatsDClient = new NoopDogStatsDClient()
const noopLLMObs = new NoopLLMObsSDK(noop)
const noopOpenFeatureProvider = new NoopFlaggingProvider()
const noopAIGuard = new NoopAIGuardSDK()

/** @type {import('../../src/index')} Proxy */
class NoopProxy {
  constructor () {
    this._tracer = noop
    this.appsec = noopAppsec
    this.dogstatsd = noopDogStatsDClient
    this.llmobs = noopLLMObs
    this.openfeature = noopOpenFeatureProvider
    this.aiguard = noopAIGuard
    this.setBaggageItem = (key, value) => {}
    this.getBaggageItem = (key) => {}
    this.getAllBaggageItems = () => {}
    this.removeBaggageItem = (keyToRemove) => {}
    this.removeAllBaggageItems = () => {}
  }

  init () {
    return this
  }

  use () {
    return this
  }

  profilerStarted () {
    return Promise.resolve(false)
  }

  trace (name, options, fn) {
    if (!fn) {
      fn = options
      options = {}
    }

    if (typeof fn !== 'function') return

    options = options || {}

    return this._tracer.trace(name, options, fn)
  }

  wrap (name, options, fn) {
    if (!fn) {
      fn = options
      options = {}
    }

    if (typeof fn !== 'function') return fn

    options = options || {}

    return this._tracer.wrap(name, options, fn)
  }

  setUrl () {
    this._tracer.setUrl.apply(this._tracer, arguments)
    return this
  }

  startSpan () {
    return this._tracer.startSpan.apply(this._tracer, arguments)
  }

  inject () {
    return this._tracer.inject.apply(this._tracer, arguments)
  }

  extract () {
    return this._tracer.extract.apply(this._tracer, arguments)
  }

  scope () {
    return this._tracer.scope.apply(this._tracer, arguments)
  }

  getRumData () {
    return this._tracer.getRumData.apply(this._tracer, arguments)
  }

  setUser (user) {
    this.appsec.setUser(user)
    return this
  }

  get TracerProvider () {
    const { checkOpenTelemetryAPIDeps } = require('../opentelemetry/check_peer_deps')
    if (checkOpenTelemetryAPIDeps()) {
      return require('../opentelemetry/tracer_provider')
    }
    return require('../opentelemetry/noop/tracer_provider')
  }
}

module.exports = NoopProxy
