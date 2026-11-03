'use strict'

const { randomUUID } = require('node:crypto')

const { AudioBuffer, RAW_LIMIT } = require('./audio')

const AUDIO_PREFIX = '{"user_audio_chunk":"'
const MAX_TOOL_ID_CHARS = 1024

const EVENT_FIELDS = {
  user_transcript: 'user_transcription_event',
  audio: 'audio_event',
  agent_response: 'agent_response_event',
  agent_response_correction: 'agent_response_correction_event',
  agent_chat_response_part: 'text_response_part',
  client_tool_call: 'client_tool_call',
  context_usage: 'context_usage_event',
  agent_tool_response_full_payload: 'agent_tool_response_full_payload',
}

/** @param {unknown} value */
function rateOf (value) {
  if (typeof value !== 'string' || !/^pcm_\d+$/.test(value)) return 0
  const rate = Number(value.slice(4))
  return rate >= 8000 && rate <= 48_000 ? rate : 0
}

/** @param {unknown} value */
function eventId (value) {
  if (typeof value === 'string' && /^\d{1,100}$/.test(value)) return BigInt(value)
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined
}

/** @param {unknown} value */
function textOf (value) {
  if (typeof value === 'string') return value.slice(0, 100_000)
  return ''
}

/** @param {unknown} value */
function toolIdOf (value) {
  return typeof value === 'string' && value.length <= MAX_TOOL_ID_CHARS ? value : undefined
}

/**
 * @typedef {{runInContext?: <T>(fn: () => T) => T}} Scope
 * @typedef {{
 * id: bigint, input: AudioBuffer, output: AudioBuffer, userText: string,
 * responses: Map<string, string>, completed: Set<string>, calls: Map<string, object>,
 * results: Map<string, object>, tools: Set<object>, model?: string, start: number,
 * responseTime: number, toolEnd: number, retired: boolean, playbackEnd?: number, interrupted: boolean,
 * failed: boolean, metadata: Record<string, unknown>, scope: Scope, root?: object, llm?: object,
 * boundaryResponse?: boolean, closed?: boolean, text?: string, sessionId?: string,
 * inputRate?: number, outputRate?: number, argumentsSize: number, argumentSizes: Map<string, number>,
 * }} Turn
 * @typedef {{
 * begin: (turn: Turn) => void, finish: (turn: Turn) => void,
 * retain: () => boolean, agentId: string,
 * }} Options
 */

class Session {
  /** @type {{runInContext?: <T>(fn: () => T) => T}} */
  scope = {}
  /** @type {object | undefined} */
  socket = undefined
  /** @type {(failed: boolean) => void} */
  finalize = () => {}
  /** @type {Map<bigint, Turn>} */
  turns = new Map()
  pending = new AudioBuffer()
  pendingText = ''
  early = []
  earlySize = 0
  earlyOverflow = false
  negotiated = false
  inputRate = 0
  outputRate = 0
  /** @type {string} */
  sessionId = randomUUID()
  lastInterrupt = -1n
  lastFinalized = -1n
  /** @type {bigint | undefined} */
  filteredAudioId = undefined
  closed = false
  #waiting = false
  /** @type {Map<bigint, string>} */
  #models = new Map()

  /** @param {Options} options */
  constructor (options) { this.options = options }

  /**
   * @param {bigint} id
   * @param {number} now
   */
  turn (id, now) {
    if (this.closed) return
    const known = this.turns.get(id)
    if (known) return known
    // The server uses the interruption ID for the replacement response. Only lower
    // unknown IDs are stale; treating the boundary as stale steals the next input.
    if (id < this.lastInterrupt || id <= this.lastFinalized) return
    while (this.turns.size >= 2) this.finish(/** @type {Turn} */ (this.turns.values().next().value))
    for (const previous of this.turns.values()) previous.retired = true
    const input = this.pending
    this.pending = new AudioBuffer()
    this.pending.activity = input.activity.continueAt(input.duration(this.inputRate))
    /** @type {Turn} */
    const turn = {
      id,
      input,
      output: new AudioBuffer(),
      userText: this.pendingText,
      argumentsSize: 0,
      argumentSizes: new Map(),
      responses: new Map(),
      completed: new Set(),
      calls: new Map(),
      results: new Map(),
      tools: new Set(),
      start: input.start ?? now,
      responseTime: now,
      toolEnd: now,
      retired: false,
      interrupted: false,
      boundaryResponse: id === this.lastInterrupt,
      model: this.#models.get(id),
      failed: false,
      scope: {},
      metadata: {
        agent_id: this.options.agentId,
        ttfa_eligible: false,
        audio_timing_source: 'sdk_transport',
        audio_playback: 'estimated',
        event_id: String(id),
      },
    }
    if (id === this.filteredAudioId) {
      turn.output.present = true
      turn.output.omit()
      turn.metadata.output_audio_omitted_reason = 'sdk_interruption_filter'
    }
    this.pendingText = ''
    this.#models.delete(id)
    this.turns.set(id, turn)
    this.options.begin(turn)
    return turn
  }

  /**
   * @param {string} raw
   * @param {number} now
   */
  sendRaw (raw, now) {
    // The SDK emits this single-field envelope for every microphone frame. Other JSON shapes,
    // additional fields, and escaped values still use the normal parser.
    if (raw.startsWith(AUDIO_PREFIX) && raw.endsWith('"}') &&
        raw.indexOf('"', AUDIO_PREFIX.length) === raw.length - 2 &&
        !raw.includes('\\', AUDIO_PREFIX.length)) {
      this.send({ user_audio_chunk: raw.slice(AUDIO_PREFIX.length, -2) }, now)
    } else {
      this.send(JSON.parse(raw), now)
    }
  }

  /**
   * @param {object} event
   * @param {number} now
   */
  send (event, now) {
    if (this.closed || !event || typeof event !== 'object') return
    if (typeof event.user_audio_chunk === 'string') {
      const encoded = event.user_audio_chunk
      if (this.inputRate) this.pending.append(encoded, now, this.inputRate, true, this.options.retain())
      else if (this.negotiated) {
        this.pending.present = true
        this.pending.omit()
      } else if (!this.earlyOverflow) {
        this.earlySize += encoded.length
        if (this.early.length < 256 && this.earlySize <= RAW_LIMIT * 4 / 3 && this.options.retain()) {
          this.early.push([encoded, now])
        } else {
          this.early = []
          this.earlyOverflow = true
        }
      }
    } else if (event.type === 'user_message') {
      this.pendingText = textOf(this.pendingText ? `${this.pendingText}\n${textOf(event.text)}` : textOf(event.text))
    } else if (event.type === 'client_tool_result') {
      const id = toolIdOf(event.tool_call_id)
      if (id === undefined) return
      for (const turn of this.turns.values()) {
        if (turn.calls.has(id)) this.toolResult(turn, id, event.result)
      }
    }
  }

  /**
   * @param {object} event
   * @param {number} now
   * @param {boolean} [audioAccepted] Whether the SDK delivered this audio to its output interface.
   */
  receive (event, now, audioAccepted = true) {
    if (this.closed || !event || typeof event !== 'object') return
    const kind = event.type
    if (kind === 'conversation_initiation_metadata') {
      const data = event.conversation_initiation_metadata_event
      if (!data || typeof data !== 'object') return
      this.sessionId = textOf(data.conversation_id) || this.sessionId
      this.negotiated = true
      this.inputRate = rateOf(data.user_input_audio_format)
      this.outputRate = rateOf(data.agent_output_audio_format)
      if (this.earlyOverflow || (!this.inputRate && this.early.length)) {
        this.pending.present = true
        this.pending.omit()
      }
      for (const [encoded, sent] of this.early) {
        this.pending.append(encoded, sent, this.inputRate, true, this.options.retain())
      }
      this.early = []
      this.earlySize = 0
      this.earlyOverflow = false
      return
    }
    if (kind === 'queue_status') {
      const status = event.queue_status_event?.status
      if (status === 'admitted') this.#waiting = false
      else if (status === 'waiting' || status === 'timed_out') this.#waiting = true
      return
    }
    if (kind === 'audio' && this.#waiting) return
    if (kind === 'interruption') {
      const id = eventId(event.interruption_event?.event_id)
      if (id === undefined) return
      if (id > this.lastInterrupt) {
        this.lastInterrupt = id
        this.filteredAudioId = undefined
      }
      for (const turn of this.turns.values()) {
        if (turn.id <= id && (!this.responseFinished(turn, now) || (turn.playbackEnd ?? 0) > now)) {
          turn.interrupted = true
          turn.output.trim(now, this.outputRate)
        }
      }
      return
    }
    if (kind === 'vad_score') {
      if (this.inputRate && this.options.retain()) {
        this.pending.activity.observe(event.vad_score_event?.vad_score, this.pending.duration(this.inputRate), now)
      }
      return
    }
    if (!Object.hasOwn(EVENT_FIELDS, kind)) return
    const data = event[EVENT_FIELDS[kind]]
    if (!data || typeof data !== 'object') return
    const id = eventId(data.event_id)
    if (id === undefined) return
    if (kind === 'audio' && !audioAccepted) {
      if (id === this.lastInterrupt) {
        this.filteredAudioId = id
        const rejected = this.turns.get(id)
        if (rejected?.boundaryResponse) {
          rejected.output.present = true
          rejected.output.omit()
          rejected.metadata.output_audio_omitted_reason = 'sdk_interruption_filter'
        }
      }
      return
    }
    if (kind === 'audio' && id < this.lastInterrupt) return
    if (kind === 'context_usage') {
      const model = textOf(data.model)
      if (!model) return
      const known = this.turns.get(id)
      if (known) known.model = model
      else if (id >= this.lastInterrupt && id > this.lastFinalized) {
        this.#models.delete(id)
        this.#models.set(id, model)
        while (this.#models.size > 2) this.#models.delete(/** @type {bigint} */ (this.#models.keys().next().value))
      }
      return
    }
    const lookupOnly = kind === 'agent_tool_response_full_payload'
    const turn = lookupOnly ? this.turns.get(id) : this.turn(id, now)
    if (!turn) return
    switch (kind) {
      case 'user_transcript': turn.userText = textOf(data.user_transcript); break
      case 'audio': {
        const previousDuration = turn.output.duration(this.outputRate)
        turn.output.append(data.audio_base_64, now, this.outputRate, false, this.options.retain())
        const duration = turn.output.duration(this.outputRate) - previousDuration
        if (duration > 0) turn.playbackEnd = Math.max(turn.playbackEnd ?? now, now) + duration
        this.boundAudio(turn)
        break
      }
      case 'client_tool_call':
        if (toolIdOf(data.tool_call_id) === undefined) {
          turn.metadata.tool_calls_omitted = true
          break
        }
        if (typeof data.tool_call_id === 'string' && (turn.calls.has(data.tool_call_id) || turn.calls.size < 64)) {
          const argumentsJson = JSON.stringify(data.parameters || {})
          const used = turn.argumentsSize - (turn.argumentSizes.get(data.tool_call_id) || 0)
          const argumentsFit = argumentsJson.length + used <= 100_000
          if (!argumentsFit) turn.metadata.tool_arguments_truncated = true
          const size = argumentsFit ? argumentsJson.length : 2 // omitted arguments retain the empty object
          turn.argumentSizes.set(data.tool_call_id, size)
          turn.argumentsSize = used + size
          turn.calls.set(data.tool_call_id, {
            name: textOf(data.tool_name),
            arguments: argumentsFit ? data.parameters || {} : {},
            toolId: data.tool_call_id,
            type: 'tool',
          })
        }
        break
      case 'agent_tool_response_full_payload':
        if (toolIdOf(data.tool_call_id) !== undefined && turn.calls.has(data.tool_call_id)) {
          this.toolResult(turn, data.tool_call_id, data.full_tool_result)
        }
        break
      default: this.response(turn, kind, data, now)
    }
    return turn
  }

  /**
   * @param {Turn} turn
   * @param {string} kind
   * @param {object} data
   * @param {number} now
   */
  response (turn, kind, data, now) {
    const key = textOf(data.response_id)
    if (!turn.responses.has(key) && turn.responses.size >= 64) return
    if (kind === 'agent_chat_response_part') {
      if (turn.completed.has(key)) return
      const prefix = data.type === 'start' ? '' : (turn.responses.get(key) || '')
      turn.responses.set(key, textOf(prefix + textOf(data.text)))
      if (data.type === 'stop') turn.completed.add(key)
    } else {
      const field = kind === 'agent_response_correction' ? 'corrected_agent_response' : 'agent_response'
      turn.responses.set(key, textOf(data[field]))
      turn.completed.add(key)
    }
    turn.responseTime = now
  }

  /**
   * @param {Turn} turn
   * @param {string} id
   * @param {unknown} result
   */
  toolResult (turn, id, result) {
    if (turn.closed || toolIdOf(id) === undefined) return ''
    let remaining = 100_000
    for (const [key, item] of turn.results) if (key !== id) remaining -= item.result.length
    let text = typeof result === 'string' ? result : JSON.stringify(result) ?? ''
    if (text.length > remaining) {
      text = text.slice(0, remaining)
      turn.metadata.tool_results_truncated = true
    }
    turn.results.set(id, { toolId: id, result: text, type: 'tool_result' })
    return text
  }

  /**
   * Completion remains estimated: final text plus the observed playback queue, or retirement by a
   * newer response. A text event alone cannot prove that audio delivery has finished.
   * @param {Turn} turn
   * @param {number} now
   */
  responseFinished (turn, now) {
    return turn.retired || (turn.responses.size > 0 && turn.completed.size === turn.responses.size &&
      turn.tools.size === 0 && turn.playbackEnd !== undefined && now >= turn.playbackEnd)
  }

  /** @param {Turn} turn */
  boundAudio (turn) { if (turn.input.size + turn.output.size > RAW_LIMIT) turn.output.omit() }

  /** @param {Turn} turn */
  finish (turn) {
    if (turn.closed) return
    this.turns.delete(turn.id)
    turn.metadata.interrupted = turn.interrupted
    if (turn.model) turn.metadata.configured_llm = turn.model
    if (turn.input.overflow || turn.output.overflow) turn.metadata.audio_omitted = true
    this.options.finish(turn)
    turn.closed = true
    turn.input.chunks = []
    turn.output.chunks = []
    if (turn.id > this.lastFinalized) this.lastFinalized = turn.id
  }

  /**
   * @param {number} now
   * @param {boolean} failed
   */
  close (now, failed) {
    if (this.closed) return
    this.closed = true
    const last = [...this.turns.values()].at(-1)
    if (last) {
      last.input.extend(this.pending, this.inputRate)
      this.boundAudio(last)
    }
    this.pending = new AudioBuffer()
    this.pendingText = ''
    this.early = []
    this.#models.clear()
    for (const turn of this.turns.values()) {
      if (failed && !this.responseFinished(turn, now) && !turn.interrupted) turn.failed = true
      turn.output.trim(now, this.outputRate)
      this.finish(turn)
    }
  }
}

module.exports = Session
