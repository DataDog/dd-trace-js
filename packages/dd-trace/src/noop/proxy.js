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
  #tracer

  constructor () {
    this.#tracer = noop
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

    return this.#tracer.trace(name, options, fn)
  }

  wrap (name, options, fn) {
    if (!fn) {
      fn = options
      options = {}
    }

    if (typeof fn !== 'function') return fn

    options = options || {}

    return this.#tracer.wrap(name, options, fn)
  }

  setUrl () {
    this.#tracer.setUrl.apply(this.#tracer, arguments)
    return this
  }

  startSpan () {
    return this.#tracer.startSpan.apply(this.#tracer, arguments)
  }

  inject () {
    return this.#tracer.inject.apply(this.#tracer, arguments)
  }

  extract () {
    return this.#tracer.extract.apply(this.#tracer, arguments)
  }

  scope () {
    return this.#tracer.scope.apply(this.#tracer, arguments)
  }

  getRumData () {
    return this.#tracer.getRumData.apply(this.#tracer, arguments)
  }

  setUser (user) {
    this.appsec.setUser(user)
    return this
  }

  get TracerProvider () {
    return require('../opentelemetry/tracer_provider')
  }
}

module.exports = NoopProxy
