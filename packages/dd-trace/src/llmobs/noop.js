'use strict'

let NoopExperiments

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
    NoopExperiments ??= require('./experiments/noop')
    return new NoopExperiments('LLM Observability is not enabled')
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

  /**
   * Resolve an exact, environment-targeted, or latest managed prompt.
   * @param {string} promptId
   * @param {import('../../../../index').llmobs.GetPromptOptions} [options]
   * @returns {Promise<import('../../../../index').llmobs.ManagedPrompt>}
   */
  getPrompt (promptId, options) { return promptUnavailable() }

  /**
   * Refresh the prompt selected by the current environment.
   * @param {string} promptId
   * @returns {Promise<import('../../../../index').llmobs.ManagedPrompt | undefined>}
   */
  refreshPrompt (promptId) { return promptUnavailable() }

  /**
   * Clear the in-memory and/or persistent prompt caches.
   * @param {import('../../../../index').llmobs.ClearPromptCacheOptions} [options]
   */
  clearPromptCache (options) {}

  /**
   * Create a prompt and its first version.
   * @param {string} promptId
   * @param {import('../../../../index').llmobs.PromptTemplateMessage[]} template
   * @param {import('../../../../index').llmobs.CreatePromptOptions} [options]
   * @returns {Promise<import('../../../../index').llmobs.PromptResponse>}
   */
  createPrompt (promptId, template, options) { return promptUnavailable() }

  /**
   * Create another version of an existing prompt.
   * @param {string} promptId
   * @param {import('../../../../index').llmobs.PromptTemplateMessage[]} template
   * @param {import('../../../../index').llmobs.CreatePromptVersionOptions} [options]
   * @returns {Promise<import('../../../../index').llmobs.PromptVersionResponse>}
   */
  createPromptVersion (promptId, template, options) { return promptUnavailable() }

  /**
   * Update prompt metadata.
   * @param {string} promptId
   * @param {import('../../../../index').llmobs.UpdatePromptOptions} options
   * @returns {Promise<import('../../../../index').llmobs.PromptResponse>}
   */
  updatePrompt (promptId, options) { return promptUnavailable() }

  /**
   * Update one prompt version.
   * @param {string} promptId
   * @param {number} version
   * @param {import('../../../../index').llmobs.UpdatePromptVersionOptions} options
   * @returns {Promise<import('../../../../index').llmobs.PromptVersionResponse>}
   */
  updatePromptVersion (promptId, version, options) { return promptUnavailable() }

  /**
   * Delete a prompt and all its versions.
   * @param {string} promptId
   * @returns {Promise<import('../../../../index').llmobs.DeletedPromptResponse>}
   */
  deletePrompt (promptId) { return promptUnavailable() }

  /**
   * List prompts.
   * @returns {Promise<import('../../../../index').llmobs.PromptResponse[]>}
   */
  listPrompts () { return promptUnavailable() }

  /**
   * List versions for a prompt.
   * @param {string} promptId
   * @returns {Promise<import('../../../../index').llmobs.PromptVersionResponse[]>}
   */
  listPromptVersions (promptId) { return promptUnavailable() }
}

module.exports = NoopLLMObs
