'use strict'

const { randomUUID } = require('node:crypto')

const { AudioBuffer, RAW_LIMIT } = require('./audio')

const EVENT_FIELDS = {
  user_transcript: 'user_transcription_event',
  audio: 'audio_event',
  agent_response: 'agent_response_event',
  agent_response_correction: 'agent_response_correction_event',
  agent_response_complete: 'agent_response_complete_event',
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

/**
 * @typedef {{runInContext?: <T>(fn: () => T) => T}} Scope
 * @typedef {{
 * id: bigint, input: AudioBuffer, output: AudioBuffer, userText: string,
 * responses: Map<string, string>, completed: Set<string>, calls: Map<string, object>,
 * results: Map<string, object>, tools: Set<object>, model?: string, start: number,
 * responseTime: number, toolEnd: number, responseComplete: boolean, interrupted: boolean,
 * failed: boolean, metadata: Record<string, unknown>, scope: Scope, root?: object, llm?: object,
 * boundaryResponse?: boolean, closed?: boolean, text?: string, sessionId?: string,
 * inputRate?: number, outputRate?: number,
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
  inputRate = 0
  outputRate = 0
  /** @type {string} */
  sessionId = randomUUID()
  lastInterrupt = -1n
  lastFinalized = -1n
  /** @type {bigint | undefined} */
  filteredAudioId = undefined
  closed = false

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
    for (const previous of this.turns.values()) previous.responseComplete = true
    const input = this.pending
    this.pending = new AudioBuffer()
    this.pending.activity = input.activity.continueAt(input.duration(this.inputRate))
    /** @type {Turn} */
    const turn = {
      id,
      input,
      output: new AudioBuffer(),
      userText: this.pendingText,
      responses: new Map(),
      completed: new Set(),
      calls: new Map(),
      results: new Map(),
      tools: new Set(),
      start: input.start ?? now,
      responseTime: now,
      toolEnd: now,
      responseComplete: false,
      interrupted: false,
      boundaryResponse: id === this.lastInterrupt,
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
    this.turns.set(id, turn)
    this.options.begin(turn)
    return turn
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
      else if (!this.earlyOverflow) {
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
      for (const turn of this.turns.values()) {
        if (turn.calls.has(event.tool_call_id)) this.toolResult(turn, event.tool_call_id, event.result)
      }
    }
  }

  /**
   * @param {object} event
   * @param {number} now
   */
  receive (event, now) {
    if (this.closed || !event || typeof event !== 'object') return
    const kind = event.type
    if (kind === 'conversation_initiation_metadata') {
      const data = event.conversation_initiation_metadata_event
      if (!data || typeof data !== 'object') return
      this.sessionId = textOf(data.conversation_id) || this.sessionId
      this.inputRate = rateOf(data.user_input_audio_format)
      this.outputRate = rateOf(data.agent_output_audio_format)
      if (this.earlyOverflow) this.pending.omit()
      for (const [encoded, sent] of this.early) {
        this.pending.append(encoded, sent, this.inputRate, true, this.options.retain())
      }
      this.early = []
      this.earlySize = 0
      this.earlyOverflow = false
      return
    }
    if (kind === 'interruption') {
      const id = eventId(event.interruption_event?.event_id)
      if (id === undefined) return
      if (id > this.lastInterrupt) {
        this.lastInterrupt = id
        this.filteredAudioId = undefined
      }
      for (const turn of this.turns.values()) {
        if (turn.id <= id && (!turn.responseComplete || (turn.output.end(this.outputRate) ?? 0) > now)) {
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
    if (kind === 'audio' && id <= this.lastInterrupt) {
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
    const lookupOnly = ['agent_response_complete', 'context_usage', 'agent_tool_response_full_payload'].includes(kind)
    const turn = lookupOnly ? this.turns.get(id) : this.turn(id, now)
    if (!turn) return
    switch (kind) {
      case 'user_transcript': turn.userText = textOf(data.user_transcript); break
      case 'audio':
        turn.output.append(data.audio_base_64, now, this.outputRate, false, this.options.retain())
        this.boundAudio(turn)
        break
      case 'context_usage':
        turn.model = textOf(data.model) || turn.model
        break
      case 'agent_response_complete':
        turn.responseTime = now
        turn.responseComplete = true
        break
      case 'client_tool_call':
        if (typeof data.tool_call_id === 'string' && turn.calls.size < 64) {
          const argumentsJson = JSON.stringify(data.parameters || {})
          const used = [...turn.calls.values()].reduce((size, call) => size + JSON.stringify(call.arguments).length, 0)
          const argumentsFit = argumentsJson.length + used <= 100_000
          if (!argumentsFit) turn.metadata.tool_arguments_truncated = true
          turn.calls.set(data.tool_call_id, {
            name: textOf(data.tool_name),
            arguments: argumentsFit ? data.parameters || {} : {},
            toolId: data.tool_call_id,
            type: 'tool',
          })
        }
        break
      case 'agent_tool_response_full_payload':
        if (turn.calls.has(data.tool_call_id)) this.toolResult(turn, data.tool_call_id, data.full_tool_result)
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
    const key = textOf(data.text_response_id)
    if (!turn.responses.has(key) && turn.responses.size >= 64) return
    if (kind === 'agent_chat_response_part') {
      if (turn.completed.has(key)) return
      const prefix = data.type === 'start' ? '' : (turn.responses.get(key) || '')
      turn.responses.set(key, textOf(prefix + textOf(data.text)))
      if (key && data.type === 'stop') turn.completed.add(key)
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
    if (turn.closed) return ''
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
    for (const turn of this.turns.values()) {
      if (failed && !turn.responseComplete && !turn.interrupted) turn.failed = true
      turn.output.trim(now, this.outputRate)
      this.finish(turn)
    }
  }
}

module.exports = Session
