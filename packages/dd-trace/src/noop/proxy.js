'use strict'

const NoopAppsecSdk = require('../appsec/sdk/noop')
const NoopLLMObsSDK = require('../llmobs/noop')
const NoopFlaggingProvider = require('../openfeature/noop')
const NoopAIGuardSDK = require('../aiguard/noop')
const { PublicSpan, unwrap } = require('../opentracing/public/span')
const { markManualService } = require('../opentracing/public/service-source')
const NoopDogStatsDClient = require('./dogstatsd')
const NoopTracer = require('./tracer')

const noop = new NoopTracer()
const noopAppsec = new NoopAppsecSdk()
const noopDogStatsDClient = new NoopDogStatsDClient()
const noopLLMObs = new NoopLLMObsSDK(noop)
const noopOpenFeatureProvider = new NoopFlaggingProvider()
const noopAIGuard = new NoopAIGuardSDK()
const noopProfiling = {
  setCustomLabelKeys () {},
  runWithLabels (labels, fn) { return fn() },
}

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

    return this._tracer.trace(name, markManualService(options || {}), fn)
  }

  wrap (name, options, fn) {
    if (!fn) {
      fn = options
      options = {}
    }

    if (typeof fn !== 'function') return fn

    return this._tracer.wrap(name, markManualService(options || {}), fn)
  }

  setUrl () {
    this._tracer.setUrl.apply(this._tracer, arguments)
    return this
  }

  startSpan (name, options) {
    options = markManualService(options)

    let childOf
    if (options?.childOf instanceof PublicSpan) {
      childOf = unwrap(options.childOf)
    }

    if (childOf !== undefined) {
      options = { ...options, childOf }
    }

    return new PublicSpan(this._tracer.startSpan(name, options))
  }

  inject(context, format, carrier) {
    if (context instanceof PublicSpan) {
      context = unwrap(context)
    }
    return this._tracer.inject(context, format, carrier)
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

  get profiling () {
    return noopProfiling
  }

  get TracerProvider () {
    return require('../opentelemetry/tracer_provider')
  }
}

module.exports = NoopProxy
