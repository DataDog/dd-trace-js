'use strict'

const NoopAppsecSdk = require('../appsec/sdk/noop')
const NoopLLMObsSDK = require('../llmobs/noop')
const NoopFlaggingProvider = require('../openfeature/noop')
const NoopAIGuardSDK = require('../aiguard/noop')
const { PublicTracer } = require('../opentracing/public/tracer')
const NoopDogStatsDClient = require('./dogstatsd')
const NoopTracer = require('./tracer')

const noop = new NoopTracer()
const noopAppsec = new NoopAppsecSdk()
const noopDogStatsDClient = new NoopDogStatsDClient()
const noopLLMObs = new NoopLLMObsSDK(noop)
const noopOpenFeatureProvider = new NoopFlaggingProvider()
const noopAIGuard = new NoopAIGuardSDK()
const publicNoopTracer = new PublicTracer(noop)
const noopProfiling = {
  setCustomLabelKeys () {},
  runWithLabels (labels, fn) { return fn() },
}

/** @type {import('../../src/index')} Proxy */
class NoopProxy {
  #publicTracerCache
  #publicTracerFor

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

  get #publicTracer () {
    if (this.#publicTracerFor !== this._tracer) {
      this.#publicTracerFor = this._tracer
      this.#publicTracerCache = this._tracer === noop
        ? publicNoopTracer
        : new PublicTracer(this._tracer)
    }
    return this.#publicTracerCache
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

  trace () {
    return this.#publicTracer.trace(...arguments)
  }

  wrap () {
    return this.#publicTracer.wrap(...arguments)
  }

  setUrl () {
    this.#publicTracer.setUrl(...arguments)
    return this
  }

  startSpan () {
    return this.#publicTracer.startSpan(...arguments)
  }

  inject () {
    return this.#publicTracer.inject(...arguments)
  }

  extract () {
    return this.#publicTracer.extract(...arguments)
  }

  scope () {
    return this.#publicTracer.scope(...arguments)
  }

  getRumData () {
    return this.#publicTracer.getRumData(...arguments)
  }

  setUser (user) {
    this.appsec.setUser(user)
    return this
  }

  get profiling () {
    return noopProfiling
  }

  get TracerProvider () {
    return require('../opentelemetry/tracer_provider')
  }
}

module.exports = NoopProxy
