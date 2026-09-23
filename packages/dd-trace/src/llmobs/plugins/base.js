'use strict'

const log = require('../../log')
const { PROPAGATED_SESSION_ID_KEY } = require('../constants/tags')
const { MODEL_BACKED_SPAN_KINDS, setGenAiApmTags, updateGenAiApmTags } = require('../gen-ai-tags')
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
   */
  get _llmobsEnabled () {
    return this._tracerConfig.llmobs.DD_LLMOBS_ENABLED
  }

  setLLMObsTags (ctx) {
    throw new Error('setLLMObsTags must be implemented by the subclass')
  }

  /**
   * The `gen_ai.*` values an integration can only resolve once the operation finished, such as
   * token usage or a session id the response carries. Only used while LLMObs is disabled; the
   * LLMObs layer reads them off the span event instead. Fields left out keep their start value.
   *
   * @param {object} ctx
   * @param {string} spanKind LLMObs span kind resolved at span start
   * @returns {import('../gen-ai-tags').GenAiApmTags | void}
   */
  getGenAiApmEndTags (ctx, spanKind) {}

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
      this.#setGenAiApmEndTags(ctx)
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
   */
  #setGenAiApmTagsFromRegisterOptions (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    try {
      const registerOptions = this.getLLMObsSpanRegisterOptions(ctx)
      if (!registerOptions?.kind) return

      // `asyncEnd` needs these back: the kind to gate the usage metrics, and the model in case an
      // integration promotes the kind to one that must always report a model
      ctx.genAiApmStartTags = {
        spanKind: registerOptions.kind,
        modelName: registerOptions.modelName,
        modelProvider: registerOptions.modelProvider,
        mlApp: registerOptions.mlApp,
        sessionId: registerOptions.sessionId,
      }

      this._setGenAiApmTags(span, ctx.genAiApmStartTags)
    } catch (e) {
      log.debug('Failed to set gen_ai APM tags for %s:', this.constructor.name, e.message)
    }
  }

  /**
   * @param {object} ctx
   */
  #setGenAiApmEndTags (ctx) {
    const span = ctx.currentStore?.span
    const startTags = ctx.genAiApmStartTags
    if (!span || !startTags) return

    const { spanKind } = startTags

    try {
      const endTags = this.getGenAiApmEndTags(ctx, spanKind)
      if (!endTags) return

      // An integration may correct the kind, the way the tagger's `changeKind` does. A correction
      // into a model-backed kind has to go back through `setGenAiApmTags`, which applies the model
      // and provider defaults a model-backed span always reports; an update alone would leave the
      // span claiming a kind the enabled path could never emit without a model.
      const promotedToModelBacked = endTags.spanKind &&
        endTags.spanKind !== spanKind &&
        MODEL_BACKED_SPAN_KINDS.has(endTags.spanKind)

      if (promotedToModelBacked) {
        this._setGenAiApmTags(span, { ...startTags, ...endTags })
      } else {
        updateGenAiApmTags(span, { spanKind, ...endTags })
      }
    } catch (e) {
      log.debug('Failed to set gen_ai APM end tags for %s:', this.constructor.name, e.message)
    }
  }

  /**
   * Writes the `gen_ai.*` APM attributes.
   *
   * No `gen_ai.application.name`: ml_app is an LLM Observability concept, and with LLMObs off the
   * only value left to report is the service name the span already carries. dd-trace-py's reduced
   * path leaves it out for the same reason.
   *
   * @param {import('../../opentracing/span')} span
   * @param {import('../gen-ai-tags').GenAiApmTags} tags
   */
  _setGenAiApmTags (span, tags) {
    // the in-process session default is written by the tagger, which never runs on this path, so
    // an inherited session can only have come from an upstream service
    const propagatedSessionId = span.context()._trace.tags[PROPAGATED_SESSION_ID_KEY]

    setGenAiApmTags(span, { ...tags, sessionId: tags.sessionId || propagatedSessionId })
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
