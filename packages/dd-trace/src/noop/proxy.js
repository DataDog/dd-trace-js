'use strict'

const NoopAppsecSdk = require('../appsec/sdk/noop')
const NoopLLMObsSDK = require('../llmobs/noop')
const NoopFlaggingProvider = require('../openfeature/noop')
const NoopAIGuardSDK = require('../aiguard/noop')
const NoopDogStatsDClient = require('./dogstatsd')
const NoopTracer = require('./tracer')
const { SVC_SRC_KEY } = require('../constants')

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
    if (options.service || options?.tags?.service) {
      options.tags = {
        ...options.tags,
        [SVC_SRC_KEY]: 'm',
      }
    }
    return this._tracer.trace(name, options, fn)
  }

  wrap (name, options, fn) {
    if (!fn) {
      fn = options
      options = {}
    }

    if (typeof fn !== 'function') return fn

    options = options || {}
    if (options.service || options?.tags?.service) {
      options.tags = {
        ...options.tags,
        [SVC_SRC_KEY]: 'm',
      }
    }
    return this._tracer.wrap(name, options, fn)
  }

  setUrl () {
    this._tracer.setUrl.apply(this._tracer, arguments)
    return this
  }

  startSpan () {
    const options = arguments[1]
    if (options?.tags && (options.tags.service !== undefined || options.tags['service.name'] !== undefined)) {
      options.tags = {
        ...options.tags,
        [SVC_SRC_KEY]: 'm',
      }
      arguments[1] = options
    }
    // Monkey patch setTag to add _dd.svc_src tag whenever it's called through the proxy
    const spanInstance = this._tracer.startSpan.apply(this._tracer, arguments)
    const originalSetTag = spanInstance.setTag
    if (originalSetTag) {
      spanInstance.setTag = function (key, value) {
        if (key === 'service' || key === 'service.name') {
          originalSetTag.call(this, SVC_SRC_KEY, 'm')
        }
        return originalSetTag.call(this, key, value)
      }
    }
    return spanInstance
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
    return require('../opentelemetry/tracer_provider')
  }
}

module.exports = NoopProxy
