'use strict'

const log = require('../../log')
const { storage: llmobsStorage } = require('../storage')
const telemetry = require('../telemetry')
const { captureTrackedPrompt } = require('../prompts/tracking')

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
    const enabled = this._tracerConfig.llmobs.DD_LLMOBS_ENABLED
    if (!enabled) return

    const parentStore = llmobsStorage.getStore()
    const apmStore = ctx.currentStore
    const span = apmStore?.span
    const prompt = captureTrackedPrompt(ctx) ?? parentStore?.prompt

    const registerOptions = this.getLLMObsSpanRegisterOptions(ctx)

    // register options may not be set for operations we do not trace with llmobs
    // ie OpenAI fine tuning jobs, file jobs, etc.
    if (registerOptions || prompt) {
      ctx.llmobs = { parent: parentStore, prompt }
      llmobsStorage.enterWith({ ...parentStore, span: registerOptions ? span : parentStore?.span, prompt })
    }

    if (registerOptions) {
      telemetry.incrementLLMObsSpanStartCount({ autoinstrumented: true, integration: this.constructor.integration })

      this._tagger.registerLLMObsSpan(span, {
        parent: parentStore?.span,
        integration: this.constructor.integration,
        ...registerOptions,
      })
    }
  }

  end (ctx) {
    const enabled = this._tracerConfig.llmobs.DD_LLMOBS_ENABLED
    if (!enabled) return

    if (ctx.llmobs) llmobsStorage.enterWith(ctx.llmobs.parent)
  }

  asyncEnd (ctx) {
    // even though llmobs span events won't be enqueued if llmobs is disabled
    // we should avoid doing any computations here (these listeners aren't disabled)
    const enabled = this._tracerConfig.llmobs.DD_LLMOBS_ENABLED
    if (!enabled) return

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

    try {
      this._tagger.tagAutoPrompt(span, ctx.llmobs?.prompt)
    } catch (error) {
      log.debug('Failed to automatically track managed prompt: %s', error.message)
    }
  }

  configure (config) {
    // we do not want to enable any LLMObs plugins if it is disabled on the tracer, or if the
    // integration opted out via `tracer.use(<name>, { llmobs: false })`. Opting out only disables
    // the LLMObs layer: the integration keeps emitting APM spans and propagating trace context.
    const llmobsEnabled = this._tracerConfig.llmobs.DD_LLMOBS_ENABLED
    if (llmobsEnabled === false || config?.llmobs === false) {
      config = typeof config === 'boolean' ? false : { ...config, enabled: false } // override to false
    }
    super.configure(config)
  }
}

module.exports = LLMObsPlugin
