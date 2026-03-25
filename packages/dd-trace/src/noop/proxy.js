'use strict'

const NoopAppsecSdk = require('../appsec/sdk/noop')
const NoopLLMObsSDK = require('../llmobs/noop')
const NoopFlaggingProvider = require('../openfeature/noop')
const NoopAIGuardSDK = require('../aiguard/noop')
const { SVC_SRC_KEY } = require('../constants')
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
    if (options.service || options?.tags?.service || options?.tags?.['service.name']) {
      options.tags = {
        ...options.tags,
        [SVC_SRC_KEY]: 'm',
      }
    }

    const callback = fn.length > 1
      ? function (span, done) {
        return fn(patchSpanAddTags(addPatches(span)), done)
      }
      : function (span) {
        return fn(patchSpanAddTags(addPatches(span)))
      }

    return this._tracer.trace(name, options, callback)
  }

  wrap (name, options, fn) {
    if (!fn) {
      fn = options
      options = {}
    }

    if (typeof fn !== 'function') return fn

    options = options || {}
    if (options.service || options?.tags?.service || options?.tags?.['service.name']) {
      options.tags = {
        ...options.tags,
        [SVC_SRC_KEY]: 'm',
      }
    }

    // wrap only does callback as promise
    const callback = function (span, done) {
      return fn(patchSpanAddTags(addPatches(span)), done)
    }

    return this._tracer.wrap(name, options, callback)
  }

  setUrl () {
    this._tracer.setUrl.apply(this._tracer, arguments)
    return this
  }

  startSpan () {
    const options = arguments[1]
    if (options?.tags && (options.tags.service !== undefined || options.tags['service.name'] !== undefined) ||
      options?.service) {
      options.tags = {
        ...options.tags,
        [SVC_SRC_KEY]: 'm',
      }
      arguments[1] = options
    }
    return addPatches(this._tracer.startSpan.apply(this._tracer, arguments))
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

function addPatches (span) {
  return patchSpanAddTags(patchSpanSetTag(span))
}

function patchSpanSetTag (span) {
  const originalSetTag = span?.setTag

  if (!originalSetTag) {
    return span
  }

  span.setTag = function setTag (key, value) {
    if (key === 'service' || key === 'service.name') {
      originalSetTag.call(this, SVC_SRC_KEY, 'm')
    }
    return originalSetTag.call(this, key, value)
  }

  return span
}

function patchSpanAddTags (span) {
  const originalAddTags = span?.addTags

  if (!originalAddTags) {
    return span
  }

  span.addTags = function addTags (tags) {
    if (tags.service || tags['service.name']) {
      tags = { ...tags, [SVC_SRC_KEY]: 'm' }
    }
    return originalAddTags.call(this, tags)
  }

  return span
}

module.exports = NoopProxy
