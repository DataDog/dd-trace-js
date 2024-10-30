'use strict'

class NoopLLMObs {
  constructor (noopTracer) {
    this._tracer = noopTracer
  }

  get enabled () {
    return false
  }

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

        return llmobs.wrap({ name: ctx.name, ...options }, target)
      } else {
        const propertyKey = ctxOrPropertyKey
        if (descriptor) {
          if (typeof descriptor.value !== 'function') return descriptor

          const original = descriptor.value
          descriptor.value = llmobs.wrap({ name: propertyKey, ...options }, original)

          return descriptor
        } else {
          if (typeof target[propertyKey] !== 'function') return target[propertyKey]

          const original = target[propertyKey]
          Object.defineProperty(target, propertyKey, {
            ...Object.getOwnPropertyDescriptor(target, propertyKey),
            value: llmobs.wrap({ name: propertyKey, ...options }, original)
          })

          return target
        }
      }
    }
  }

  annotate (span, options) {}

  exportSpan (span) {
    return {}
  }

  submitEvaluation (llmobsSpanContext, options) {}

  flush () {}
}

module.exports = NoopLLMObs
