'use strict'

const { pcm16ToWav } = require('../audio-codec')
const { fitsInlineAudioBudget, formatAudioPartWithGuard } = require('../audio-utils')
const { AUDIO_FALLBACK, LLMOBS_AUDIO_INLINE_MAX_BYTES } = require('../constants/audio')
const { SESSION_ID } = require('../constants/tags')
const { storage } = require('../storage')
const LLMObsPlugin = require('./base')

/** @typedef {import('../../../../datadog-instrumentations/src/elevenlabs/session').Scope} Scope */
/** @typedef {import('../../../../datadog-core/src/storage').Store<unknown>} Store */

class ElevenLabsLLMObsPlugin extends LLMObsPlugin {
  static id = 'elevenlabs_llmobs'
  static integration = 'elevenlabs'
  static prefix = 'tracing:apm:elevenlabs:span'
  static emitsGenAiApmTags = false

  constructor (...args) {
    super(...args)
    this.addSub('dd-trace:elevenlabs:audio', () => {})
    this.addSub('dd-trace:elevenlabs:capture-context', message => {
      const scope = /** @type {Scope} */ (message)
      // An absent store intentionally restores an explicit root context.
      const store = /** @type {Store} */ (storage.getStore())
      const previous = scope.runInContext ?? (fn => fn())
      scope.runInContext = fn => previous(() => storage.run(store, fn))
    })
    this.addSub('apm:elevenlabs:finish', /** @param {object} ctx */ ctx => {
      if (!ctx.finished) this.setLLMObsTags(ctx)
    })
  }

  /** @param {object} ctx */
  getLLMObsSpanRegisterOptions (ctx) {
    const options = {
      kind: ctx.kind,
      name: ctx.name,
      sessionId: ctx.session.sessionId,
    }
    if (ctx.kind === 'llm') {
      options.modelName = ctx.turn.model
      options.modelProvider = 'elevenlabs'
    }
    return options
  }

  /** @param {object} ctx */
  end (ctx) {
    if (!ctx.deferred && !ctx.promise) this.setLLMObsTags(ctx)
    super.end(ctx)
  }

  /** @param {object} ctx */
  asyncEnd (ctx) { if (!ctx.finished) this.setLLMObsTags(ctx) }

  /** @param {object} ctx */
  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return
    this._tagger._setTag(span, SESSION_ID, ctx.session.sessionId)
    const { turn } = ctx
    const metadata = { ...turn.metadata }
    if (ctx.activity !== undefined) metadata.user_speech_activity = ctx.activity
    this._tagger.tagMetadata(span, metadata)
    if (ctx.kind === 'tool') {
      this._tagger.tagTextIO(span, JSON.stringify(ctx.parameters), ctx.output)
      return
    }
    if (ctx.kind !== 'llm') {
      if (ctx.name === 'elevenlabs audio turn') this._tagger.tagTextIO(span, turn.userText, turn.text)
      else this._tagger.tagTextIO(span, undefined, ctx.transcript)
      return
    }
    if (turn.model) this._tagger.tagModelName(span, turn.model)
    const input = { role: 'user', content: turn.userText || '' }
    const output = { role: 'assistant', content: turn.text || '' }
    if (turn.calls.size) output.toolCalls = [...turn.calls.values()]
    if (turn.results.size) input.toolResults = [...turn.results.values()]
    let budget = LLMOBS_AUDIO_INLINE_MAX_BYTES
    for (const [message, audio, rate] of [
      [input, turn.input, turn.inputRate], [output, turn.output, turn.outputRate],
    ]) {
      if (rate && audio.size && !audio.overflow && fitsInlineAudioBudget(audio.size + 44, budget)) {
        const part = formatAudioPartWithGuard(pcm16ToWav(audio.bytes(), rate), 'audio/wav', budget)
        if (part) {
          message.audioParts = [part]
          budget -= part.content.length
        }
      }
      if (audio.present && !message.audioParts) {
        metadata.audio_omitted = true
        message.content ||= AUDIO_FALLBACK
      }
    }
    this._tagger.tagMetadata(span, metadata)
    this._tagger.tagLLMIO(span, [input], [output])
  }
}

module.exports = ElevenLabsLLMObsPlugin
