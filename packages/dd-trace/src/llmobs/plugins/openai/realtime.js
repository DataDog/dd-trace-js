'use strict'

const dc = require('dc-polyfill')

const {
  g711ToPcm16,
  g711Variant,
  isPcm16AudioMime,
  pcm16ToWav,
} = require('../../audio-codec')
const { fitsInlineAudioBudget, formatAudioPartWithGuard } = require('../../audio-utils')
const {
  AUDIO_FALLBACK,
  G711_SAMPLE_RATE,
  LLMOBS_AUDIO_INLINE_MAX_BYTES,
  PCM16_BYTES_PER_SAMPLE,
  WAV_HEADER_BYTES,
} = require('../../constants/audio')
const { storage: llmobsStorage } = require('../../storage')
const { safeJsonParse } = require('../../util')
const LLMObsPlugin = require('../base')
const { getModelProviderAndClient } = require('./utils')

// Never published to. The instrumentation retains a turn's audio only while something is
// subscribed here, so the subscription is the signal, and this handler is never invoked.
const audioChannel = dc.channel('dd-trace:openai:realtime:audio')
const retainAudio = () => {}

/**
 * @typedef {import('../../audio-utils').AudioPart} AudioPart
 * @typedef {{
 *   role: string,
 *   content: string,
 *   audioParts?: AudioPart[],
 *   toolCalls?: object[],
 *   toolResults?: object[],
 * }} Message
 */

/**
 * Turn a turn side's raw audio into a playable audio part.
 *
 * Realtime audio is raw PCM16 (24 kHz mono) by default, which the UI can't render, so it is wrapped
 * in a WAV container — lossless, just a header. G.711 telephony audio, used by phone-call
 * integrations, is decoded to PCM16 and likewise WAV-wrapped at its fixed 8 kHz rate. Anything else
 * is passed to the size guard as-is, which keeps it only if it is renderable and within budget.
 *
 * Both conversions expand what they are given — G.711 doubles it, and either way a WAV header is
 * prepended — so the budget is checked against the size the conversion *would* produce before
 * running it. Checking afterwards, as the guard alone does, means decoding and copying megabytes
 * only to discard them: the retention cap admits roughly twice what a G.711 turn can ever inline.
 *
 * @param {Buffer} audio
 * @param {string} mimeType
 * @param {number} sampleRate
 * @param {number} maxBytes - Encoded bytes still available to this turn. See `setLLMObsTags`.
 * @returns {AudioPart | undefined}
 */
function buildAudioPart (audio, mimeType, sampleRate, maxBytes) {
  if (!audio.length) return

  if (isPcm16AudioMime(mimeType)) {
    if (!fitsInlineAudioBudget(audio.length + WAV_HEADER_BYTES, maxBytes)) return
    return formatAudioPartWithGuard(pcm16ToWav(audio, sampleRate), 'audio/wav', maxBytes)
  }

  const variant = g711Variant(mimeType)
  if (variant !== undefined) {
    if (!fitsInlineAudioBudget(audio.length * PCM16_BYTES_PER_SAMPLE + WAV_HEADER_BYTES, maxBytes)) return
    return formatAudioPartWithGuard(
      pcm16ToWav(g711ToPcm16(audio, variant), G711_SAMPLE_RATE), 'audio/wav', maxBytes
    )
  }

  return formatAudioPartWithGuard(audio, mimeType, maxBytes)
}

/**
 * Encoded size an already-built message contributes to the span event, which for audio is the
 * base64 content itself.
 *
 * @param {Message | undefined} message
 */
function audioBytesOf (message) {
  return message?.audioParts?.[0]?.content?.length ?? 0
}

/**
 * @param {object[]} toolCalls
 * @returns {object[]}
 */
function parseToolCallArguments (toolCalls) {
  return toolCalls.map(toolCall => ({ ...toolCall, arguments: safeJsonParse(toolCall.arguments ?? '', {}) }))
}

/**
 * Build the message for one side of a turn.
 *
 * @param {string} role
 * @param {import('../../../../../datadog-instrumentations/src/openai-realtime/session').TurnSide} side
 * @param {number} maxAudioBytes - Encoded audio bytes still available to this turn.
 * @returns {Message | undefined}
 */
function buildMessage (role, side, maxAudioBytes) {
  const audioPart = buildAudioPart(side.audio, side.mimeType, side.sampleRate, maxAudioBytes)

  let content = side.transcript || side.text
  if (!content && audioPart === undefined && side.audioPresent) {
    // Audio was captured but couldn't be turned into a playable part — an unsupported format, or
    // over the size budget — and there is no transcript, so surface a marker rather than let the
    // turn look silently empty.
    content = AUDIO_FALLBACK
  }

  const toolCalls = side.toolCalls?.length ? parseToolCallArguments(side.toolCalls) : undefined
  const toolResults = side.toolResults.length ? side.toolResults : undefined

  if (!content && audioPart === undefined && toolCalls === undefined && toolResults === undefined) return

  /** @type {Message} */
  const message = { role, content: content || '' }
  if (audioPart !== undefined) message.audioParts = [audioPart]
  if (toolCalls !== undefined) message.toolCalls = toolCalls
  if (toolResults !== undefined) message.toolResults = toolResults

  return message
}

/**
 * @param {{ input_tokens?: number, output_tokens?: number, total_tokens?: number } | undefined} usage
 * @returns {Record<string, number> | undefined}
 */
function usageMetrics (usage) {
  if (!usage) return

  const { input_tokens: inputTokens, output_tokens: outputTokens } = usage
  let { total_tokens: totalTokens } = usage

  /** @type {Record<string, number>} */
  const metrics = {}
  if (inputTokens != null) metrics.input_tokens = inputTokens
  if (outputTokens != null) metrics.output_tokens = outputTokens
  // Mirror the chat and responses fallback.
  if (totalTokens == null && inputTokens != null && outputTokens != null) {
    totalTokens = inputTokens + outputTokens
  }
  if (totalTokens != null) metrics.total_tokens = totalTokens

  return metrics.total_tokens === undefined && metrics.input_tokens === undefined ? undefined : metrics
}

/**
 * LLM Observability spans for one OpenAI Realtime turn.
 *
 * The turn is modelled as a small tree — a `workflow` root with a `user speech` window, the `llm`
 * generation span, and an `agent speech` window — so span duration is meaningful (the llm span
 * measures model work, not the human's speaking time) and time-to-first-agent-audio falls out of the
 * span boundaries. Consumers identify the phase spans by span kind and name, so those strings are a
 * contract: renaming one is a breaking change for the UI and the backend metric alike.
 */
class RealtimeLLMObsPlugin extends LLMObsPlugin {
  static integration = 'openai'
  static system = 'openai'

  /**
   * The instrumentation replays the turn with `traceSync`, which never publishes `asyncEnd`, so tag
   * on `end` instead — before the sibling tracing plugin's `end` finishes the span, since the LLM
   * Observability plugins are registered first.
   *
   * @param {object} ctx
   */
  end (ctx) {
    super.end(ctx)
    super.asyncEnd(ctx)
  }
}

/** The whole perceived turn. Carries the transcripts so the waterfall row reads as a conversation. */
class RealtimeTurnLLMObsPlugin extends RealtimeLLMObsPlugin {
  static id = 'openai_realtime_turn_llmobs'
  static prefix = 'tracing:apm:openai:realtime:turn'

  constructor (...args) {
    super(...args)

    this.addSub('dd-trace:openai:realtime:capture-context', turn => {
      if (!this._tracerConfig.llmobs.DD_LLMOBS_ENABLED) return

      // Composed on top of the tracing plugin's, so the replayed tree restores both the APM and the
      // LLM Observability context the caller had active when the turn began.
      const store = llmobsStorage.getStore()
      const previous = turn.runInContext ?? (fn => fn())
      turn.runInContext = fn => previous(() => llmobsStorage.run(store, fn))
    })
  }

  getLLMObsSpanRegisterOptions (ctx) {
    return {
      kind: 'workflow',
      // Provider-agnostic `audio turn` marker, so a consumer can gate on "is this a voice turn?".
      name: 'realtime audio turn',
      sessionId: ctx.turn.sessionId,
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const { input, output } = ctx.turn
    this._tagger.tagTextIO(span, input.transcript || input.text, output.transcript || output.text)
  }
}

/** The model's generation work. The turn's audio, tool calls and token usage ride here. */
class RealtimeResponseLLMObsPlugin extends RealtimeLLMObsPlugin {
  static id = 'openai_realtime_response_llmobs'
  static prefix = 'tracing:apm:openai:realtime:response'

  #audioSubscribed = false

  /**
   * Tracks the audio capability subscription against LLM Observability rather than against the
   * plugin being enabled. The two used to be the same thing; now the reduced path leaves the
   * plugin subscribed while building no payload, and only the payload reads `side.audio`, so
   * staying subscribed would make the instrumentation buffer megabytes per turn for no consumer.
   *
   * Not managed through `addSub`, whose subscriptions follow the plugin: `LLMObs.enable()` and
   * `disable()` flip `DD_LLMOBS_ENABLED` at runtime without reconfiguring plugins, so this is
   * re-evaluated on `configure` (before any traffic) and again per turn (to catch those toggles).
   *
   * Drop this if `buildMessage` stops reading `side.audio`, and the buffering stops with it.
   */
  #syncAudioSubscription () {
    const shouldRetain = Boolean(this._enabled && this._llmobsEnabled)
    if (shouldRetain === this.#audioSubscribed) return

    if (shouldRetain) {
      audioChannel.subscribe(retainAudio)
    } else {
      audioChannel.unsubscribe(retainAudio)
    }

    this.#audioSubscribed = shouldRetain
  }

  /**
   * @override
   */
  configure (config) {
    super.configure(config)
    this.#syncAudioSubscription()
  }

  /**
   * @override
   */
  start (ctx) {
    this.#syncAudioSubscription()
    super.start(ctx)
  }

  getLLMObsSpanRegisterOptions (ctx) {
    const { turn } = ctx
    const { modelProvider, client } = getModelProviderAndClient(turn.basePath)

    return {
      kind: 'llm',
      name: `${client}.createRealtimeResponse`,
      modelName: turn.model || 'unknown_model',
      modelProvider,
      sessionId: turn.sessionId,
    }
  }

  /**
   * @override
   */
  getGenAiApmEndTags (ctx) {
    // the turn reports its usage only once the response completes
    return { metrics: usageMetrics(ctx.turn?.usage) }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const { turn } = ctx

    // One budget for the whole event, spent across both sides rather than offered to each.
    // A turn normally carries audio on both sides, so a per-message budget lets two individually
    // accepted clips add up to twice the limit — and `writers/spans.js` responds by truncating the
    // event's *entire* input and output, losing the transcripts too. Input is served first and the
    // output falls back to its transcript when nothing is left, which is the same graceful
    // degradation an oversize single clip already gets.
    const inputMessage = buildMessage('user', turn.input, LLMOBS_AUDIO_INLINE_MAX_BYTES)
    const remainingAudioBytes = LLMOBS_AUDIO_INLINE_MAX_BYTES - audioBytesOf(inputMessage)
    const outputMessage = buildMessage('assistant', turn.output, remainingAudioBytes)

    this._tagger.tagLLMIO(span, inputMessage ? [inputMessage] : [], outputMessage ? [outputMessage] : [])
    this._tagger.tagMetadata(span, turn.metadata)

    const metrics = usageMetrics(turn.usage)
    if (metrics !== undefined) this._tagger.tagMetrics(span, metrics)
  }
}

/** A speaking window — the human's or the agent's. These are timing regions; the audio rides on the llm span. */
class RealtimeSpeechLLMObsPlugin extends RealtimeLLMObsPlugin {
  static id = 'openai_realtime_speech_llmobs'
  static prefix = 'tracing:apm:openai:realtime:speech'

  getLLMObsSpanRegisterOptions (ctx) {
    return {
      kind: 'workflow',
      name: ctx.phase.llmobsName,
      sessionId: ctx.turn.sessionId,
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    this._tagger.tagTextIO(span, undefined, ctx.transcript)
  }
}

module.exports = [
  RealtimeTurnLLMObsPlugin,
  RealtimeResponseLLMObsPlugin,
  RealtimeSpeechLLMObsPlugin,
]
