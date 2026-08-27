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

  /**
   * Reject Prompt Management access before tracer initialization.
   * @param {string} promptId
   * @param {object} [options]
   * @returns {Promise<import('./prompts/prompt')>}
   */
  getPrompt (promptId, options) { return promptUnavailable() }

  /**
   * Reject prompt refresh before tracer initialization.
   * @param {string} promptId
   * @returns {Promise<import('./prompts/prompt') | undefined>}
   */
  refreshPrompt (promptId) { return promptUnavailable() }

  /**
   * Ignore cache clearing before tracer initialization.
   * @param {{hot?: boolean, warm?: boolean}} [options]
   * @returns {void}
   */
  clearPromptCache (options) {}

  /**
   * Reject prompt creation before tracer initialization.
   * @param {string} promptId
   * @param {Array<{role: string, content: string}>} template
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  createPrompt (promptId, template, options) { return promptUnavailable() }

  /**
   * Reject prompt-version creation before tracer initialization.
   * @param {string} promptId
   * @param {Array<{role: string, content: string}>} template
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  createPromptVersion (promptId, template, options) { return promptUnavailable() }

  /**
   * Reject prompt updates before tracer initialization.
   * @param {string} promptId
   * @param {object} options
   * @returns {Promise<object>}
   */
  updatePrompt (promptId, options) { return promptUnavailable() }

  /**
   * Reject prompt-version updates before tracer initialization.
   * @param {string} promptId
   * @param {number} version
   * @param {object} options
   * @returns {Promise<object>}
   */
  updatePromptVersion (promptId, version, options) { return promptUnavailable() }

  /**
   * Reject prompt deletion before tracer initialization.
   * @param {string} promptId
   * @returns {Promise<object>}
   */
  deletePrompt (promptId) { return promptUnavailable() }

  /**
   * Reject prompt listing before tracer initialization.
   * @returns {Promise<object[]>}
   */
  listPrompts () { return promptUnavailable() }

  /**
   * Reject prompt-version listing before tracer initialization.
   * @param {string} promptId
   * @returns {Promise<object[]>}
   */
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
