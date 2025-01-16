'use strict'

const log = require('../../log')
const { storage: llmobsStorage } = require('../storage')

const TracingPlugin = require('../../plugins/tracing')
const LLMObsTagger = require('../tagger')

class LLMObsPlugin extends TracingPlugin {
  constructor (...args) {
    super(...args)

    this._tagger = new LLMObsTagger(this._tracerConfig, true)
  }

  setLLMObsTags (ctx) {
    throw new Error('setLLMObsTags must be implemented by the subclass')
  }

  getLLMObsSpanRegisterOptions (ctx) {
    throw new Error('getLLMObsSPanRegisterOptions must be implemented by the subclass')
  }

  start (ctx) {
    // even though llmobs span events won't be enqueued if llmobs is disabled
    // we should avoid doing any computations here (these listeners aren't disabled)
    const enabled = this._tracerConfig.llmobs.enabled
    if (!enabled) return

    const parent = this.getLLMObsParent(ctx)
    const apmStore = ctx.currentStore
    const span = apmStore?.span

    const registerOptions = this.getLLMObsSpanRegisterOptions(ctx)

    // register options may not be set for operations we do not trace with llmobs
    // ie OpenAI fine tuning jobs, file jobs, etc.
    if (registerOptions) {
      ctx.llmobs = {} // initialize context-based namespace
      llmobsStorage.enterWith({ span })
      ctx.llmobs.parent = parent

      this._tagger.registerLLMObsSpan(span, { parent, ...registerOptions })
    }
  }

  end (ctx) {
    const enabled = this._tracerConfig.llmobs.enabled
    if (!enabled) return

    // only attempt to restore the context if the current span was an LLMObs span
    const apmStore = ctx.currentStore
    const span = apmStore?.span
    if (!LLMObsTagger.tagMap.has(span)) return

    const parent = ctx.llmobs.parent
    llmobsStorage.enterWith({ span: parent })
  }

  asyncEnd (ctx) {
    // even though llmobs span events won't be enqueued if llmobs is disabled
    // we should avoid doing any computations here (these listeners aren't disabled)
    const enabled = this._tracerConfig.llmobs.enabled
    if (!enabled) return

    const apmStore = ctx.currentStore
    const span = apmStore?.span
    if (!span) {
      log.debug(
        `Tried to start an LLMObs span for ${this.constructor.name} without an active APM span.
        Not starting LLMObs span.`
      )
      return
    }

    this.setLLMObsTags(ctx)
  }

  configure (config) {
    // we do not want to enable any LLMObs plugins if it is disabled on the tracer
    const llmobsEnabled = this._tracerConfig.llmobs.enabled
    if (llmobsEnabled === false) {
      config = typeof config === 'boolean' ? false : { ...config, enabled: false } // override to false
    }
    super.configure(config)
  }

  getLLMObsParent () {
    const store = llmobsStorage.getStore()
    return store?.span
  }
}

module.exports = LLMObsPlugin
