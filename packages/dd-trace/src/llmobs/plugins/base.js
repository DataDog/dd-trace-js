'use strict'

const log = require('../../log')
const {
  PROPAGATED_ML_APP_KEY,
  PROPAGATED_SESSION_ID_KEY,
  SESSION_ID_TRACE_DEFAULT_KEY,
} = require('../constants/tags')
const { setGenAiApmTags, setGenAiApmUsageMetrics } = require('../gen-ai-tags')
const { storage: llmobsStorage } = require('../storage')
const telemetry = require('../telemetry')

const TracingPlugin = require('../../plugins/tracing')
const LLMObsTagger = require('../tagger')

/**
 * @typedef {object} LLMObsSpanRegisterOptions
 * @property {string} kind LLMObs span kind
 * @property {string} [name]
 * @property {string} [modelName]
 * @property {string} [modelProvider]
 * @property {string} [mlApp]
 * @property {string} [sessionId]
 */

class LLMObsPlugin extends TracingPlugin {
  constructor (...args) {
    super(...args)

    this._tagger = new LLMObsTagger(this._tracerConfig, true)
  }

  /**
   * Whether the LLMObs layer is active. When it is not, the plugin stays subscribed but only
   * emits the `gen_ai.*` APM attributes.
   *
   * @returns {boolean}
   */
  get _llmobsEnabled () {
    return this._tracerConfig.llmobs.DD_LLMOBS_ENABLED
  }

  setLLMObsTags (ctx) {
    throw new Error('setLLMObsTags must be implemented by the subclass')
  }

  /**
   * Token usage for the `gen_ai.usage.*` APM metrics while LLMObs is disabled. Integrations that
   * can read usage off the response without building the LLMObs payload should override this.
   *
   * @param {object} ctx
   * @returns {Record<string, number> | void}
   */
  getGenAiApmUsageMetrics (ctx) {}

  /**
   * @param {object} ctx
   * @returns {LLMObsSpanRegisterOptions | undefined}
   */
  getLLMObsSpanRegisterOptions (ctx) {
    throw new Error('getLLMObsSPanRegisterOptions must be implemented by the subclass')
  }

  start (ctx) {
    if (!this._llmobsEnabled) {
      this.#setGenAiApmTagsFromRegisterOptions(ctx)
      return
    }

    const parentStore = llmobsStorage.getStore()
    const apmStore = ctx.currentStore
    const span = apmStore?.span

    const registerOptions = this.getLLMObsSpanRegisterOptions(ctx)

    // register options may not be set for operations we do not trace with llmobs
    // ie OpenAI fine tuning jobs, file jobs, etc.
    if (registerOptions) {
      telemetry.incrementLLMObsSpanStartCount({ autoinstrumented: true, integration: this.constructor.integration })

      ctx.llmobs = {} // initialize context-based namespace
      llmobsStorage.enterWith({ ...parentStore, span })
      ctx.llmobs.parent = parentStore

      this._tagger.registerLLMObsSpan(span, {
        parent: parentStore?.span,
        integration: this.constructor.integration,
        ...registerOptions,
      })
    }
  }

  end (ctx) {
    if (!this._llmobsEnabled) return

    // only attempt to restore the context if the current span was an LLMObs span
    const apmStore = ctx.currentStore
    const span = apmStore?.span
    if (!LLMObsTagger.tagMap.has(span)) return

    const parentStore = ctx.llmobs.parent
    llmobsStorage.enterWith(parentStore)
  }

  asyncEnd (ctx) {
    if (!this._llmobsEnabled) {
      this.#setGenAiApmUsageMetrics(ctx)
      return
    }

    const apmStore = ctx.currentStore
    const span = apmStore?.span
    if (!span) {
      log.debug(
        'Tried to start an LLMObs span for %s without an active APM span. Not starting LLMObs span.',
        this.constructor.name
      )
      return
    }

    this.setLLMObsTags(ctx)
  }

  /**
   * Resolves the LLMObs annotations the `gen_ai.*` APM attributes need from the span register
   * options, which every integration already builds for the LLMObs layer.
   *
   * @param {object} ctx
   * @returns {void}
   */
  #setGenAiApmTagsFromRegisterOptions (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    try {
      const registerOptions = this.getLLMObsSpanRegisterOptions(ctx)
      if (!registerOptions?.kind) return

      // the usage metrics only arrive at `asyncEnd`, by which point the kind is gone
      ctx.genAiApmSpanKind = registerOptions.kind

      this._setGenAiApmTags(span, {
        spanKind: registerOptions.kind,
        modelName: registerOptions.modelName,
        modelProvider: registerOptions.modelProvider,
        mlApp: registerOptions.mlApp,
        sessionId: registerOptions.sessionId,
      })
    } catch (e) {
      log.debug('Failed to set gen_ai APM tags for %s:', this.constructor.name, e.message)
    }
  }

  /**
   * @param {object} ctx
   * @returns {void}
   */
  #setGenAiApmUsageMetrics (ctx) {
    const span = ctx.currentStore?.span
    if (!span || !ctx.genAiApmSpanKind) return

    try {
      const metrics = this.getGenAiApmUsageMetrics(ctx)
      if (metrics) setGenAiApmUsageMetrics(span, ctx.genAiApmSpanKind, metrics)
    } catch (e) {
      log.debug('Failed to set gen_ai APM usage metrics for %s:', this.constructor.name, e.message)
    }
  }

  /**
   * Writes the `gen_ai.*` APM attributes, defaulting the application and conversation to what the
   * tagger would have resolved for the LLMObs span event.
   *
   * @param {import('../../opentracing/span')} span
   * @param {import('../gen-ai-tags').GenAiApmTags} tags
   * @returns {void}
   */
  _setGenAiApmTags (span, tags) {
    const traceTags = span.context()._trace.tags

    setGenAiApmTags(span, {
      ...tags,
      mlApp: tags.mlApp ||
        traceTags[PROPAGATED_ML_APP_KEY] ||
        this._tracerConfig.llmobs.mlApp ||
        this._tracerConfig.service,
      sessionId: tags.sessionId ||
        traceTags[SESSION_ID_TRACE_DEFAULT_KEY] ||
        traceTags[PROPAGATED_SESSION_ID_KEY],
    })
  }

  configure (config) {
    // an integration opt-out via `tracer.use(<name>, { llmobs: false })` disables the LLMObs layer
    // entirely. When only LLMObs itself is disabled we stay subscribed: the handlers then emit the
    // `gen_ai.*` APM attributes and skip the LLMObs payload.
    if (config?.llmobs === false) {
      config = typeof config === 'boolean' ? false : { ...config, enabled: false } // override to false
    }
    super.configure(config)
  }
}

module.exports = LLMObsPlugin
