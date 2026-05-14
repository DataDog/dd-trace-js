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
  constructor () {
    this._tracer = noop
    this._publicTracer = publicNoopTracer
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

  trace () {
    return this._publicTracer.trace(...arguments)
  }

  wrap () {
    return this._publicTracer.wrap(...arguments)
  }

  setUrl () {
    this._publicTracer.setUrl(...arguments)
    return this
  }

  startSpan () {
    return this._publicTracer.startSpan(...arguments)
  }

  inject () {
    return this._publicTracer.inject(...arguments)
  }

  extract () {
    return this._publicTracer.extract(...arguments)
  }

  scope () {
    return this._publicTracer.scope(...arguments)
  }

  getRumData () {
    return this._publicTracer.getRumData(...arguments)
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
