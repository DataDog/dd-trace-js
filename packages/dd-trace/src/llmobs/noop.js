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

  annotate (span, options) {}

  exportSpan (span) {}

  submitEvaluation (llmobsSpanContext, options) {}

  startSpan (options = {}) {
    const name = options.name || options.kind
    return this._tracer.startSpan(name, options)
  }

  trace (fn, options = {}) {
    if (typeof fn !== 'function') return

    const name = options.name || options.kind || fn.name

    return this._tracer.trace(name, options, fn)
  }

  wrap (fn, options = {}) {
    if (typeof fn !== 'function') return fn

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

        return llmobs.wrap(target, { name: ctx.name, ...options })
      } else {
        const propertyKey = ctxOrPropertyKey
        if (descriptor) {
          if (typeof descriptor.value !== 'function') return descriptor

          const original = descriptor.value
          descriptor.value = llmobs.wrap(original, { name: propertyKey, ...options })

          return descriptor
        } else {
          if (typeof target[propertyKey] !== 'function') return target[propertyKey]

          const original = target[propertyKey]
          Object.defineProperty(target, propertyKey, {
            ...Object.getOwnPropertyDescriptor(target, propertyKey),
            value: llmobs.wrap(original, { name: propertyKey, ...options })
          })

          return target
        }
      }
    }
  }

  flush () {}
}

module.exports = NoopLLMObs
