'use strict'

const { randomUUID } = require('node:crypto')

const log = require('../../../dd-trace/src/log')
const { InputAudio, OutputAudio } = require('./audio')

const MAX_TEXT = 65_536
const MAX_BLOCKS = 256
const MAX_TOOLS = 16
const MAX_TOOL_TEXT = 4096

function newTurn () {
  return {
    windows: [],
    userText: '',
    finalText: '',
    speculativeText: '',
    tools: [],
    toolResults: [],
    inputPcm: undefined,
    inputRate: 0,
    inputStart: undefined,
    inputEnd: undefined,
    output: new OutputAudio(),
    started: undefined,
    generationEnd: undefined,
    completionId: undefined,
    metrics: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    missingAudioMetrics: new Set(),
    emitted: false,
  }
}

/** @param {ReturnType<typeof newTurn>} turn */
function hasInput (turn) {
  return turn.windows.length || turn.userText || turn.toolResults.length
}

/** @param {unknown} value */
function object (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {string} text
 * @param {object} [fallback]
 */
function parse (text, fallback = {}) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/**
 * Nova's completion ID can cover the entire connection. Local response ownership is driven by
 * pending input and new generation, with FINAL text staying on the preceding response.
 */
class SonicSession {
  #emit
  #audio = new InputAudio()
  #pending = newTurn()
  #current
  #outbound = new Map()
  #blocks = new Map()
  #completed = new Set()
  #prompt
  #configuration = {}
  #outputConfiguration = {}
  #history = []
  #closed = false
  #turnIndex = 0
  #sessionId = randomUUID()
  #providerSessionId
  #totals = { input_tokens: 0, output_tokens: 0 }
  #audioTotals = { input: 0, output: 0 }

  /** @param {(descriptor: object) => void} emit */
  constructor (emit) {
    this.#emit = emit
  }

  /**
   * Observe decoded SDK union members without consuming either iterable ahead of its owner.
   * @param {{ chunk?: { bytes?: Uint8Array } }} event
   * @param {boolean} outbound
   * @param {number} [now]
   */
  observe (event, outbound, now = Date.now()) {
    if (this.#closed) return
    try {
      const bytes = event?.chunk?.bytes
      if (!ArrayBuffer.isView(bytes)) return
      const payload = parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8'))
      if (!object(payload?.event)) return
      for (const [name, data] of Object.entries(payload.event)) {
        if (!object(data)) continue
        if (outbound) this.#sent(name, data, now)
        else this.#received(name, data, now)
        if (this.#closed) break
      }
    } catch {
      // Malformed telemetry never changes transport behavior or logs captured conversation data.
      log.debug('Cannot process Nova Sonic telemetry')
    }
  }

  /**
   * @param {string} name
   * @param {object} data
   * @param {number} now
   */
  #sent (name, data, now) {
    const key = data.contentName ?? ''
    switch (name) {
      case 'sessionStart':
        for (const name of ['inferenceConfiguration', 'turnDetectionConfiguration']) {
          const config = this.#configuration[name] = {}
          if (!object(data[name])) continue
          for (const key of ['maxTokens', 'topP', 'temperature', 'endpointingSensitivity']) {
            const value = data[name][key]
            if ((typeof value === 'number' || typeof value === 'string') && String(value).length < 128) {
              config[key] = value
            }
          }
        }
        break
      case 'promptStart':
        if (this.#prompt !== undefined && this.#prompt !== data.promptName) {
          this.finish(undefined, now)
          return
        }
        this.#prompt = data.promptName
        this.#outputConfiguration = data.audioOutputConfiguration ?? {}
        break
      case 'contentStart':
        this.#outbound.set(key, { ...data, text: '' })
        if (data.type === 'AUDIO' && data.role === 'USER') this.#audio.configure(data.audioInputConfiguration)
        this.#bound(this.#outbound)
        break
      case 'audioInput': {
        const block = this.#outbound.get(key)
        if (block?.type === 'AUDIO' && block.role === 'USER') this.#audio.append(data.content, now)
        break
      }
      case 'textInput': {
        const block = this.#outbound.get(key)
        if (block && typeof data.content === 'string') block.text = (block.text + data.content).slice(0, MAX_TEXT)
        break
      }
      case 'toolResult': {
        const block = this.#outbound.get(key)
        const target = this.#current ?? this.#pending
        if (target.toolResults.length < MAX_TOOLS && typeof data.content === 'string') {
          target.toolResults.push({
            role: 'tool',
            content: '',
            toolResults: [{
              result: data.content.slice(0, MAX_TOOL_TEXT),
              toolId: block?.toolResultInputConfiguration?.toolUseId ?? '',
              type: 'tool_result',
            }],
          })
        }
        break
      }
      case 'contentEnd': {
        const block = this.#outbound.get(key)
        this.#outbound.delete(key)
        if (block?.type !== 'TEXT') break
        if (block.role === 'USER' && block.interactive) {
          this.#pending.userText = (this.#pending.userText + block.text).slice(0, MAX_TEXT)
        } else if (this.#history.length < 16) {
          const remaining = MAX_TEXT - this.#history.reduce((n, message) => n + message.content.length, 0)
          this.#history.push({
            role: String(block.role ?? 'USER').toLowerCase(), content: block.text.slice(0, remaining),
          })
        }
        break
      }
    }
  }

  /**
   * @param {Map<string, object>} map
   */
  #bound (map) {
    while (map.size > MAX_BLOCKS) map.delete(map.keys().next().value)
  }

  /**
   * @param {object} data
   * @param {number} now
   */
  #startResponse (data, now) {
    if (!this.#current || hasInput(this.#pending)) {
      if (this.#current) this.#emitTurn(this.#current, now)
      const turn = this.#pending
      this.#pending = newTurn()
      turn.started = now
      turn.completionId = data.completionId
      this.#snapshotInput(turn)
      this.#current = turn
      for (const [key, block] of this.#blocks) {
        if (block.turn !== turn) this.#blocks.delete(key)
      }
    }
    return this.#current
  }

  /** @param {ReturnType<typeof newTurn>} turn */
  #snapshotInput (turn) {
    if (turn.windows.length && !turn.inputPcm) {
      turn.inputRate = this.#audio.rate
      turn.inputPcm = this.#audio.clip(turn.windows[0].start_ms, turn.windows.at(-1).end_ms)
    }
  }

  /**
   * @param {string} name
   * @param {object} data
   * @param {number} now
   */
  #received (name, data, now) {
    // Once any turn has been emitted, its conversation identity must never change.
    if (!this.#providerSessionId && typeof data.sessionId === 'string' && data.sessionId) {
      this.#providerSessionId = data.sessionId
      if (!this.#turnIndex) this.#sessionId = data.sessionId
    }
    switch (name) {
      case 'userSpeechStart': {
        const offset = data.inputAudioOffsetMs
        if (!Number.isFinite(offset) || offset < 0 || this.#pending.windows.length >= MAX_BLOCKS) return
        this.#pending.windows.push({ start_ms: offset })
        this.#pending.inputEnd = undefined
        this.#pending.inputStart ??= this.#audio.anchor === undefined
          ? now
          : Math.min(now, this.#audio.anchor + offset)
        break
      }
      case 'userSpeechEnd': {
        const window = this.#pending.windows.at(-1)
        const end = data.inputAudioOffsetMs
        if (!window || !Number.isFinite(end) || end <= window.start_ms) return
        window.end_ms = end
        if (Number.isFinite(data.inputAudioDetectionOffsetMs)) window.detection_ms = data.inputAudioDetectionOffsetMs
        this.#pending.inputEnd = now
        break
      }
      case 'contentStart': {
        const key = data.contentId ?? ''
        if (this.#blocks.has(key) || this.#completed.has(key)) return
        const fields = object(data.additionalModelFields)
          ? data.additionalModelFields
          : parse(data.additionalModelFields)
        const stage = object(fields) ? fields.generationStage : undefined
        let turn
        if (data.role === 'ASSISTANT' || data.type === 'TOOL') {
          turn = stage === 'FINAL' && this.#current ? this.#current : this.#startResponse(data, now)
        } else {
          turn = hasInput(this.#pending) || !this.#current || this.#current.generationEnd !== undefined
            ? this.#pending
            : this.#current
        }
        this.#blocks.set(key, { data, stage, turn, text: '', control: false })
        this.#bound(this.#blocks)
        break
      }
      case 'textOutput':
      case 'audioOutput':
      case 'toolUse':
      case 'contentEnd':
        this.#content(name, data, now)
        break
      case 'usageEvent':
        this.#usage(data)
        break
      case 'completionEnd':
        this.finish(undefined, now)
        break
    }
  }

  /**
   * @param {string} name
   * @param {object} data
   * @param {number} now
   */
  #content (name, data, now) {
    const key = data.contentId ?? ''
    const block = this.#blocks.get(key)
    if (!block) return
    const { turn } = block
    if (name === 'textOutput' && typeof data.content === 'string') {
      const control = parse(data.content)
      if (block.data.role === 'ASSISTANT' && control?.interrupted === true) {
        turn.output.interrupt(now)
        block.control = true
      } else {
        block.text = (block.text + data.content).slice(0, MAX_TEXT)
      }
    } else if (name === 'audioOutput' && block.data.role === 'ASSISTANT') {
      turn.output.append(data.content, block.data.audioOutputConfiguration ?? this.#outputConfiguration, now)
    } else if (name === 'toolUse' && turn.tools.length < MAX_TOOLS) {
      const args = typeof data.content === 'string' && data.content.length <= MAX_TOOL_TEXT ? parse(data.content) : {}
      turn.tools.push({
        name: data.toolName ?? '',
        arguments: object(args) ? args : {},
        toolId: data.toolUseId ?? '',
        type: 'function',
      })
    } else if (name === 'contentEnd') {
      this.#text(block)
      if (data.stopReason === 'INTERRUPTED') turn.output.interrupt(now)
      if (block.data.type === 'AUDIO' && data.stopReason === 'END_TURN') turn.generationEnd = now
      this.#blocks.delete(key)
      this.#completed.add(key)
      if (this.#completed.size > MAX_BLOCKS) this.#completed.delete(this.#completed.values().next().value)
    }
  }

  /** @param {{ control: boolean, data: object, stage?: string, text: string, turn: object }} block */
  #text (block) {
    if (block.control) return
    const field = block.data.role === 'USER'
      ? 'userText'
      : block.stage === 'FINAL' ? 'finalText' : 'speculativeText'
    block.turn[field] = (block.turn[field] + block.text).slice(0, MAX_TEXT)
  }

  /** @param {object} data */
  #usage (data) {
    for (const direction of ['input', 'output']) {
      const key = `${direction}_tokens`
      const total = data[direction === 'input' ? 'totalInputTokens' : 'totalOutputTokens']
      if (!Number.isSafeInteger(total) || total < this.#totals[key]) continue
      const delta = total - this.#totals[key]
      this.#totals[key] = total
      const target = !this.#current || (direction === 'input' && hasInput(this.#pending))
        ? this.#pending
        : this.#current
      target.metrics[key] += delta
      target.metrics.total_tokens += delta

      // Speech usage is a subset of these totals, never another charge to total_tokens.
      const audioKey = `${direction}_audio_tokens`
      const audioTotal = data.details?.total?.[direction]?.speechTokens
      const previous = this.#audioTotals[direction]
      const valid = Number.isSafeInteger(audioTotal) && audioTotal >= 0 && audioTotal <= total &&
        (previous === undefined || audioTotal >= previous)
      const audioDelta = valid && previous !== undefined ? audioTotal - previous : undefined
      this.#audioTotals[direction] = valid ? audioTotal : delta ? undefined : previous
      if (audioDelta === undefined || audioDelta > delta) {
        if (delta || audioDelta > delta) {
          target.missingAudioMetrics.add(audioKey)
          delete target.metrics[audioKey]
        }
      } else if (!target.missingAudioMetrics.has(audioKey)) {
        target.metrics[audioKey] = (target.metrics[audioKey] ?? 0) + audioDelta
      }
    }
  }

  /**
   * @param {ReturnType<typeof newTurn>} turn
   * @param {number} now
   * @param {Error} [error]
   */
  #emitTurn (turn, now, error) {
    if (turn.emitted) return
    turn.emitted = true
    this.#turnIndex++
    try {
      this.#snapshotInput(turn)
      const start = turn.inputStart ?? turn.started ?? now
      const llmStart = turn.inputEnd ?? turn.started ?? start
      const responseEnd = Math.max(llmStart, turn.generationEnd ?? turn.output.interrupted ?? now)
      this.#emit({
        turn,
        error,
        sessionId: this.#sessionId,
        history: this.#history,
        startTime: start,
        finishTime: Math.max(responseEnd, turn.output.end ?? 0, turn.inputEnd ?? 0),
        llmStart,
        responseEnd,
        metadata: {
          turn_index: this.#turnIndex,
          completion_id: turn.completionId,
          speech_windows: turn.windows,
          ttfa_boundary: 'speech_end_event_receipt',
          output_timing: 'projected_playback',
          interrupted: turn.output.interrupted !== undefined,
          partial: turn.generationEnd === undefined,
          transcript_stage: turn.finalText ? 'FINAL' : 'SPECULATIVE',
          usage_attribution: 'event_receipt',
          generated_output_bytes: turn.output.generatedBytes,
          session_configuration: this.#configuration,
        },
      })
    } catch {
      log.debug('Cannot emit Nova Sonic turn')
    }
  }

  /**
   * Input EOF is deliberately not a finish. Only output completion, cancellation or failure flushes.
   * @param {Error} [error]
   * @param {number} [now]
   */
  finish (error, now = Date.now()) {
    if (this.#closed) return
    this.#closed = true
    for (const block of this.#blocks.values()) this.#text(block)
    if (this.#current) this.#emitTurn(this.#current, now, error)
    if (hasInput(this.#pending) || this.#pending.metrics.total_tokens || (error && !this.#current)) {
      this.#emitTurn(this.#pending, now, error)
    }
    this.#current = undefined
    this.#pending = newTurn()
    this.#blocks.clear()
    this.#outbound.clear()
    this.#completed.clear()
    this.#history = []
    this.#audio.clear()
    this.#emit = undefined
  }
}

module.exports = SonicSession
