'use strict'

const NoopExperiments = require('./experiments/noop')

function promptUnavailable () {
  return Promise.reject(new Error('Prompt Management requires tracer.init()'))
}

class NoopLLMObs {
  constructor (noopTracer) {
    this._tracer = noopTracer
  }

  get enabled () {
    return false
  }

  get experiments () {
    return new NoopExperiments('LLM Observability is not enabled')
  }

  getPrompt (promptId, options) { return promptUnavailable() }

  refreshPrompt (promptId) { return promptUnavailable() }

  clearPromptCache (options) {}

  createPrompt (promptId, template, options) { return promptUnavailable() }

  createPromptVersion (promptId, template, options) { return promptUnavailable() }

  updatePrompt (promptId, options) { return promptUnavailable() }

  updatePromptVersion (promptId, version, options) { return promptUnavailable() }

  deletePrompt (promptId) { return promptUnavailable() }

  listPrompts () { return promptUnavailable() }

  listPromptVersions (promptId) { return promptUnavailable() }

  enable (options) {}

  disable () {}

  trace (options = {}, fn) {
    if (typeof options === 'function') {
      fn = options
      options = {}
    }

    const name = options.name || options.kind || fn.name

    return this._tracer.trace(name, options, fn)
  }

  wrap (options = {}, fn) {
    if (typeof options === 'function') {
      fn = options
      options = {}
    }

    const name = options.name || options.kind || fn.name

    return this._tracer.wrap(name, options, fn)
  }

  decorate (options = {}) {
    const llmobs = this
    return function (target, ctxOrPropertyKey, descriptor) {
      if (!ctxOrPropertyKey) return target
      if (typeof ctxOrPropertyKey === 'object') {
        const ctx = ctxOrPropertyKey
        if (ctx.kind !== 'method') return target

        return llmobs.wrap({ name: ctx.name, _decorator: true, ...options }, target)
      }
      const propertyKey = ctxOrPropertyKey
      if (descriptor) {
        if (typeof descriptor.value !== 'function') return descriptor

        const original = descriptor.value
        descriptor.value = llmobs.wrap({ name: propertyKey, _decorator: true, ...options }, original)

        return descriptor
      }
      if (typeof target[propertyKey] !== 'function') return target[propertyKey]

      const original = target[propertyKey]
      Object.defineProperty(target, propertyKey, {
        ...Object.getOwnPropertyDescriptor(target, propertyKey),
        value: llmobs.wrap({ name: propertyKey, _decorator: true, ...options }, original),
      })

      return target
    }
  }

  annotate (span, options) {}

  exportSpan (span) {
    return {}
  }

  submitEvaluation (llmobsSpanContext, options) {}

  submitFeedback (options) {}

  flush () {}

  registerProcessor (processor) {}

  deregisterProcessor () {}

  annotationContext (options, fn) { return fn() }

  routingContext (options, fn) { return fn() }
}

module.exports = NoopLLMObs
