'use strict'

const { pcm16ToWav } = require('../audio-codec')
const { fitsInlineAudioBudget, formatAudioPartWithGuard } = require('../audio-utils')
const { AUDIO_FALLBACK, LLMOBS_AUDIO_INLINE_MAX_BYTES } = require('../constants/audio')
const { storage } = require('../storage')
const LLMObsPlugin = require('./base')

class SonicLLMObsPlugin extends LLMObsPlugin {
  static id = 'bedrockruntime_sonic_llmobs'
  static integration = 'bedrock'
  static system = 'aws.bedrock'
  static prefix = 'tracing:apm:aws:bedrockruntime:sonic:span'
  static emitsGenAiApmTags = false

  constructor (...args) {
    super(...args)
    this.addSub('dd-trace:aws:bedrockruntime:sonic:capture-context', context => {
      if (!this._llmobsEnabled) return
      context.enabled = true
      // Capture once at invocation, even when absent or already finished. Scoped replay restores
      // the consumer's context on every exit, including exceptions, without repairing IDs later.
      const store = storage.getStore()
      const previous = context.runInContext ?? (fn => fn())
      context.runInContext = fn => previous(() => storage.run(store, fn))
    })
  }

  /** @param {object} ctx */
  getLLMObsSpanRegisterOptions (ctx) {
    const options = {
      kind: ctx.kind,
      name: ctx.name,
      sessionId: ctx.descriptor.sessionId,
    }
    if (ctx.kind === 'llm') {
      options.modelName = ctx.model
      options.modelProvider = 'amazon'
    }
    return options
  }

  /** @param {object} ctx */
  start (ctx) {
    super.start(ctx)
    // Replay already has the complete descriptor. Annotate before any end subscriber can finish
    // the span, including when disabling/re-enabling LLMObs changes subscriber registration order.
    if (this._llmobsEnabledFor(ctx)) this.setLLMObsTags(ctx)
  }

  /** @param {object} ctx */
  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return
    const { turn, history, metadata } = ctx.descriptor
    const text = turn.finalText || turn.speculativeText
    if (ctx.kind !== 'llm') {
      if (ctx.name === 'nova sonic audio turn') this._tagger.tagTextIO(span, turn.userText, text)
      return
    }

    const input = { role: 'user', content: turn.userText || AUDIO_FALLBACK }
    const output = { role: 'assistant', content: text || AUDIO_FALLBACK }
    if (turn.tools.length) output.toolCalls = turn.tools
    const inputs = [...history, input, ...turn.toolResults]
    const outputs = [output]
    // Reserve the serialized text/tools and metadata before spending one budget across both WAVs.
    let budget = Math.max(0, LLMOBS_AUDIO_INLINE_MAX_BYTES -
      Buffer.byteLength(JSON.stringify([inputs, outputs, metadata])) - 256)
    for (const [message, pcm, rate] of [
      [input, turn.inputPcm, turn.inputRate],
      [output, turn.output.pcm(), turn.output.rate],
    ]) {
      if (!pcm?.length || !rate) continue
      const part = fitsInlineAudioBudget(pcm.length + 44, budget)
        ? formatAudioPartWithGuard(pcm16ToWav(pcm, rate), 'audio/wav', budget)
        : undefined
      if (part) {
        message.audioParts = [part]
        budget -= part.content.length
      } else if (message === output) {
        metadata.output_audio_omitted_reason = 'payload_limit'
      }
    }
    if (turn.output.omittedReason) metadata.output_audio_omitted_reason = turn.output.omittedReason
    this._tagger.tagLLMIO(span, inputs, outputs)
    this._tagger.tagMetadata(span, metadata)
    this._tagger.tagMetrics(span, turn.metrics)
  }
}

module.exports = SonicLLMObsPlugin
