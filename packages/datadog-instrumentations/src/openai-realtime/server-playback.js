'use strict'

const { randomUUID } = require('node:crypto')

const {
  bytesPerSecond,
  realtimeAudioFormatToMime,
  segmentDurationMs,
} = require('../../../dd-trace/src/llmobs/audio-codec')
const { LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES } = require('../../../dd-trace/src/llmobs/constants/audio')
const log = require('../../../dd-trace/src/log')

/**
 * @typedef {{
 *   id: string,
 *   turn: import('./turns').ResponseTurn,
 *   held: boolean,
 *   hasAudio: boolean,
 *   audioIncomplete: boolean,
 *   stopped: boolean,
 *   outOfBand: boolean,
 *   format: { mimeType: string, sampleRate: number },
 *   transcriptPending: boolean,
 *   cleared: boolean,
 *   truncated: boolean,
 *   ambiguous?: boolean,
 *   timer?: ReturnType<typeof setTimeout>,
 *   deadline?: number,
 *   phase?: "audio" | "queued" | "playback",
 *   playbackWindow?: PlaybackWindow,
 *   output: Map<string, { wanted: boolean, inFlight: boolean, parts: Map<number, { buffer?: Buffer }> }>,
 * }} PlaybackEntry
 * @typedef {{
 *   entries: PlaybackEntry[],
 *   startTime: number,
 *   finishTime: number,
 *   resolved: boolean,
 * }} PlaybackWindow
 */

const AUDIO_WAIT_MS = 5000
const PLAYBACK_WAIT_MS = 120_000
const INPUT_TRANSCRIPT_WAIT_MS = AUDIO_WAIT_MS / 2
const MAX_CACHED_AUDIO_BYTES = LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES * 4
const AUDIO_CONTENT_TYPES = new Set(['audio', 'input_audio', 'output_audio'])
const MAX_TURNS = 16
const MAX_ITEMS = 256

/**
 * Server-owned playback and stored-item audio for a RealtimeSession.
 * Generation and span emission stay with the owner; this helper only holds completed
 * turns until the playback/retrieval evidence is complete.
 */
class ServerPlayback {
  #shouldRetainAudio
  #requestItem
  #onReady
  #onTranscript
  #turns = new Map()
  #items = new Map()
  #inputs = new WeakMap()
  #requests = new Map()
  #active
  #scheduled
  #sequence = 0
  #requestPrefix = 'ddtrace_realtime_audio_' + randomUUID() + '_'
  #closed = false
  #inputFormat = { mimeType: 'audio/pcm', sampleRate: 24_000 }
  #outputFormat = { mimeType: 'audio/pcm', sampleRate: 24_000 }

  /**
   * @param {{ shouldRetainAudio: () => boolean, requestItem?: (itemId: string, eventId: string) => void,
   *   onTranscript?: (itemId: string, transcript: string, now: number) => void,
   *   onReady: (turn: import('./turns').ResponseTurn, now: number) => void }} options
   */
  constructor ({ shouldRetainAudio, requestItem, onReady, onTranscript }) {
    this.#shouldRetainAudio = shouldRetainAudio
    this.#requestItem = requestItem
    this.#onReady = onReady
    this.#onTranscript = onTranscript
  }

  /**
   * @param {{ mimeType: string, sampleRate: number }} input
   * @param {{ mimeType: string, sampleRate: number }} output
   */
  updateFormats (input, output) {
    this.#inputFormat = input
    this.#outputFormat = output
  }

  /**
   * @param {import('./turns').InputTurn} input
   * @param {boolean} [waitingForTranscript]
   */
  rememberInput (input, waitingForTranscript = false) {
    if (input.itemId !== undefined) {
      const previous = this.#inputs.get(input)
      if (previous && previous.id !== input.itemId) {
        this.forgetInput(input)
        input.resetSpeech()
      }
      input.audio.present = true
      const item = this.#bind(input.itemId, input, undefined, 'user')
      if (item) {
        item.waitingForTranscript = waitingForTranscript
        this.#inputs.set(input, item)
      }
    }
  }

  /** @param {import('./turns').InputTurn} input */
  forgetInput (input) {
    const previous = this.#inputs.get(input)
    if (!previous) return
    this.#inputs.delete(input)
    this.#clearInputWait(previous)
    previous.parts.clear()
    input.audio.clear()
    this.#items.delete(previous.id)
    for (const [id, item] of this.#requests) {
      if (item === previous) this.#requests.delete(id)
    }
  }

  /**
   * @param {string} id
   * @param {import('./turns').ResponseTurn} turn
   * @param {object} [response]
   */
  start (id, turn, response) {
    if (this.#closed) return
    if (this.#turns.size >= MAX_TURNS && !this.#evictHeld(Date.now())) return
    const format = response?.audio?.output?.format ?? response?.output_audio_format
    const entry = {
      id,
      format: format
        ? {
            mimeType: realtimeAudioFormatToMime(format),
            sampleRate: typeof format.rate === 'number' ? format.rate : this.#outputFormat.sampleRate,
          }
        : this.#outputFormat,
      turn,
      output: new Map(),
      held: false,
      transcriptPending: false,
      hasAudio: false,
      audioIncomplete: false,
      outOfBand: response?.conversation_id === null,
      stopped: false,
      cleared: false,
      truncated: false,
      timer: undefined,
      deadline: undefined,
      phase: undefined,
      playbackWindow: /** @type {PlaybackWindow | undefined} */ (undefined),
    }
    this.#turns.set(id, entry)
    const input = this.#items.get(turn.input.itemId)
    if (input) input.entry = entry
    turn.serverSpeech = {}
  }

  /**
   * @param {string} id
   * @param {object} response
   * @param {number} now
   */
  responseDone (id, response, now) {
    const entry = this.#turns.get(id)
    if (!entry || !response?.output) return
    for (const item of response.output) {
      if (item.id && item.type === 'message') this.#bindOutput(entry, item, now)
    }
  }

  /**
   * @param {import('./turns').ResponseTurn} turn
   * @param {number} now
   * @param {{ force?: boolean, transcriptPending?: boolean }} [options]
   */
  hold (turn, now, { force = false, transcriptPending = false } = {}) {
    const entry = this.#find(turn)
    if (!entry) return false
    entry.held = true
    entry.transcriptPending = transcriptPending
    if (force) {
      this.#discardUnheard(entry)
      this.#remove(entry)
      return false
    }
    if (entry.playbackWindow) this.#checkWindow(entry.playbackWindow, now, entry)
    if (this.#ready(entry)) {
      this.#remove(entry)
      return false
    }
    this.#arm(entry)
    return true
  }

  /** @param {object} event */
  onClientEvent (event) {
    if (event?.type !== 'conversation.item.retrieve') return
    const item = this.#items.get(String(event.item_id))
    if (!item) return
    this.#clearInputWait(item)
    item.inFlight = true
    item.wanted = false
    if (event.event_id) this.#requests.set(String(event.event_id), item)
  }

  /**
   * @param {object} event
   * @param {number} now
   */
  onServerEvent (event, now) {
    const type = event.type
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const entry = this.#turns.get(String(event.response_id))
      if (entry && event.item?.type === 'message') this.#bindOutput(entry, event.item, now)
    } else if (type === 'conversation.item.done') {
      const item = this.#items.get(String(event.item?.id))
      if (item && this.#hasAudio(event.item)) {
        this.#expectAudio(item, event.item)
        this.#rebuild(item, now)
        this.#want(item)
      }
    } else if (type === 'conversation.item.input_audio_transcription.completed' ||
        type === 'conversation.item.input_audio_transcription.failed') {
      const item = this.#items.get(String(event.item_id))
      if (item) {
        this.#clearInputWait(item)
        // The SDK retrieves after completed transcription. Hold the turn while
        // its synchronous handler sends, even when tracer retrieval is disabled.
        if (type.endsWith('.completed') && this.#shouldRetainAudio() && !this.#hasRetrievedAudio(item)) {
          item.wanted = true
        }
        this.#want(item)
      }
    } else if (type === 'conversation.item.retrieved') {
      this.#retrieve(event.item, now)
    } else if (type === 'conversation.item.truncated') {
      const item = this.#items.get(String(event.item_id))
      if (item) {
        const endMs = event.audio_end_ms
        if (typeof endMs === 'number' && Number.isFinite(endMs) && endMs >= 0) {
          const index = event.content_index ?? 0
          item.caps.set(index, Math.min(item.caps.get(index) ?? endMs, endMs))
          if (item.entry) {
            item.entry.truncated = true
            let after = false
            for (const output of item.entry.output.values()) {
              if (after) {
                output.lastContentIndex = -1
                output.parts.clear()
                output.wanted = false
              }
              if (output === item) {
                output.lastContentIndex = Math.min(output.lastContentIndex, index)
                after = true
              }
            }
          }
          this.#rebuild(item, now)
          this.#want(item)
          this.#check(item.entry, now)
        }
      }
    } else if (type === 'output_audio_buffer.started') {
      const entry = this.#turns.get(String(event.response_id))
      if (entry) {
        const active = this.#active
        entry.hasAudio = true
        entry.turn.serverSpeech.startTime ??= now
        // Install the new dependency before finishing older turns: removing the old
        // active turn must not shorten waits for responses still queued after this one.
        this.#active = entry
        for (const previous of this.#turns.values()) {
          if (previous === entry) break
          if (previous.held && previous.hasAudio &&
              previous.turn.serverSpeech.startTime === undefined && !previous.stopped) {
            this.#finish(previous, now, true)
          }
        }
        if (active && active !== entry) {
          // A response-specific start supplies the handoff boundary even when the
          // shared output buffer never drains between a tool preamble and its answer.
          active.stopped = true
          active.turn.serverSpeech.finishTime = now
          this.#check(active, now)
        }
        this.#check(entry, now)
      }
    } else if (type === 'output_audio_buffer.stopped' || type === 'output_audio_buffer.cleared') {
      const entry = this.#turns.get(String(event.response_id))
      if (type === 'output_audio_buffer.stopped' && this.#active && this.#active !== entry && entry) {
        const window = this.#createWindow(this.#active, entry, now)
        if (window) {
          for (const member of window.entries) {
            member.stopped = true
            member.playbackWindow = window
            member.turn.serverSpeech = {}
          }
          this.#active = undefined
          this.#checkWindow(window, now)
          this.#releaseQueuedWaits()
          return
        }
      }
      if (this.#active && this.#active !== entry) {
        // A cleared or untracked window lacks enough evidence to place its clips.
        const active = this.#active
        active.ambiguous = true
        active.stopped = true
        active.cleared = type === 'output_audio_buffer.cleared'
        active.turn.serverSpeech = {}
        this.#check(active, now)
        if (entry) entry.ambiguous = true
      }
      if (entry) {
        entry.stopped = true
        entry.cleared = type === 'output_audio_buffer.cleared'
        if (entry.ambiguous) { entry.turn.serverSpeech = {} } else { entry.turn.serverSpeech.finishTime = now }
        this.#check(entry, now)
      }
      this.#active = undefined
      this.#releaseQueuedWaits()
    } else if (type === 'error') {
      const item = this.#requests.get(String(event.error?.event_id))
      if (item) {
        item.inFlight = item.wanted = false
        item.failed = true
        this.#check(item.entry, now)
      }
    }
  }

  /** @param {{ type?: string, error?: { event_id?: unknown } } | undefined} event */
  isRetrievalError (event) {
    if (event?.type !== 'error') return false
    const id = event.error?.event_id
    if (typeof id !== 'string' || !id.startsWith(this.#requestPrefix)) return false
    const suffix = id.slice(this.#requestPrefix.length)
    const sequence = Number(suffix)
    return Number.isSafeInteger(sequence) && sequence > 0 && sequence <= this.#sequence && String(sequence) === suffix
  }

  /** @param {number} now */
  finishSession (now) {
    this.#closed = true
    clearImmediate(this.#scheduled)
    for (const entry of this.#turns.values()) this.#finish(entry, now, true)
    for (const item of this.#items.values()) {
      this.#clearInputWait(item)
      item.parts.clear()
      if (item.role === 'user') this.#inputs.delete(item.side)
    }
    this.#items.clear()
    this.#requests.clear()
  }

  /** @param {object} message */
  #hasAudio (message) {
    return message?.content?.some(part => AUDIO_CONTENT_TYPES.has(part.type))
  }

  /**
   * @param {object} entry
   * @param {object} message
   * @param {number} now
   */
  #bindOutput (entry, message, now) {
    if (typeof message.id !== 'string' || !message.id) return
    const hasAudio = this.#hasAudio(message)
    if (hasAudio) {
      entry.hasAudio = true
      entry.turn.audio.present = true
    }
    const item = this.#bind(message.id, entry.turn, entry, 'assistant')
    if (!item) {
      if (hasAudio) {
        entry.audioIncomplete = true
        entry.turn.audio.clear()
        entry.turn.audio.present = true
      }
      return
    }
    entry.output.set(item.id, item)
    this.#expectAudio(item, message)
    this.#rebuild(item, now)
    if (hasAudio && message.status === 'completed') this.#want(item)
  }

  /**
   * @param {{ expected: Set<number>, hasAudio: boolean }} item
   * @param {{ content?: Array<{ type?: string }> }} message
   */
  #expectAudio (item, message) {
    for (const [index, part] of (message.content || []).entries()) {
      if (AUDIO_CONTENT_TYPES.has(part.type)) {
        item.expected.add(index)
        item.hasAudio = true
      }
    }
  }

  /**
   * @param {string} id
   * @param {object} side
   * @param {object | undefined} entry
   * @param {string} role
   */
  #bind (id, side, entry, role) {
    let item = this.#items.get(id)
    if (!item) {
      while (this.#items.size >= MAX_ITEMS) {
        if (!this.#evictHeld(Date.now())) break
      }
      if (this.#items.size >= MAX_ITEMS) {
        let orphan
        for (const candidate of this.#items.values()) {
          if (!candidate.entry) { orphan = candidate; break }
        }
        if (!orphan) return
        this.#clearInputWait(orphan)
        orphan.parts.clear()
        orphan.side.audio.clear()
        orphan.side.audio.present = orphan.hasAudio
        this.#inputs.delete(orphan.side)
        this.#items.delete(orphan.id)
        for (const [eventId, request] of this.#requests) {
          if (request === orphan) this.#requests.delete(eventId)
        }
      }
      item = {
        id,
        side,
        entry,
        role,
        format: role === 'user' ? this.#inputFormat : entry.format,
        lastContentIndex: role === 'assistant' && entry.truncated ? -1 : Infinity,
        parts: new Map(),
        expected: new Set(),
        hasAudio: role === 'user',
        caps: new Map(),
        inFlight: false,
        wanted: false,
        attempts: 0,
        failed: false,
        retrievedComplete: false,
        waitingForTranscript: false,
        inputTimer: undefined,
      }
      this.#items.set(id, item)
    }
    if (entry) item.entry = entry
    return item
  }

  /** @param {object} item */
  #want (item) {
    const requestItem = this.#requestItem
    if (item.lastContentIndex < 0 || item.failed || item.attempts >= 2 ||
        !this.#shouldRetainAudio() || !requestItem || item.inFlight || this.#hasRetrievedAudio(item)) return
    item.wanted = true
    if (item.waitingForTranscript) {
      if (!item.inputTimer) {
        // Leave half the existing audio wait for a fallback reply if transcription
        // never arrives; normal completions let the SDK issue its own retrieval.
        item.inputTimer = setTimeout(() => {
          item.inputTimer = undefined
          if (this.#closed || this.#items.get(item.id) !== item) return
          item.waitingForTranscript = false
          item.wanted = false
          this.#want(item)
        }, INPUT_TRANSCRIPT_WAIT_MS)
        item.inputTimer.unref?.()
      }
      return
    }
    if (this.#scheduled || this.#closed) return
    this.#scheduled = setImmediate(() => {
      this.#scheduled = undefined
      for (const candidate of this.#items.values()) {
        if (!candidate.wanted || candidate.inFlight || candidate.waitingForTranscript ||
            candidate.lastContentIndex < 0) continue
        candidate.wanted = false
        if (!this.#shouldRetainAudio()) { this.#check(candidate.entry, Date.now()); continue }
        const eventId = this.#requestPrefix + (++this.#sequence)
        candidate.inFlight = true
        candidate.attempts++
        this.#requests.set(eventId, candidate)
        try {
          requestItem(candidate.id, eventId)
        } catch (error) {
          candidate.inFlight = false
          candidate.failed = true
          log.debug('Error retrieving OpenAI realtime audio: %s', error?.message)
          this.#check(candidate.entry, Date.now())
        }
      }
    })
    this.#scheduled.unref?.()
  }

  /**
   * @param {object} message
   * @param {number} now
   */
  #retrieve (message, now) {
    const item = this.#items.get(String(message?.id))
    if (!item) return
    this.#clearInputWait(item)
    item.inFlight = item.wanted = false
    item.retrievedComplete = message.status === 'completed'
    let receivedTranscript = false
    if (message.content) {
      const items = item.role === 'assistant' ? item.entry.output.values() : [item]
      let total = 0
      for (const owned of items) {
        for (const [index, part] of owned.parts) {
          if (index <= owned.lastContentIndex) total += part.bytes
        }
      }
      const updates = []
      let index = 0
      for (const part of message.content) {
        if (typeof part.audio === 'string' && index <= item.lastContentIndex) {
          const fallback = item.format
          const current = item.role === 'user' ? this.#inputFormat : this.#outputFormat
          // The protocol does not say whether retrieval transcodes older clips.
          // Without an explicit format, omit audio when the two possible codecs differ.
          const knownFormat = part.format ||
            (fallback.mimeType === current.mimeType && fallback.sampleRate === current.sampleRate)
          const mimeType = part.format ? realtimeAudioFormatToMime(part.format) : fallback.mimeType
          const sampleRate = typeof part.format?.rate === 'number' ? part.format.rate : fallback.sampleRate
          const cap = item.caps.get(index)
          const rate = bytesPerSecond(mimeType, sampleRate)
          const count = Buffer.byteLength(part.audio, 'base64')
          const bytes = cap === undefined || !rate ? count : Math.min(count, Math.floor(cap * rate / 1000))
          total += bytes - (item.parts.get(index)?.bytes ?? 0)
          updates.push({ index, audio: part.audio, bytes, mimeType, sampleRate, knownFormat })
          item.expected.add(index)
          item.hasAudio = true
        }
        if (item.role === 'user' && item.id === item.side.itemId &&
            typeof part.transcript === 'string' && part.transcript) {
          item.side.transcript ||= part.transcript
          receivedTranscript = true
        }
        index++
      }
      // Credit replaced allocations only after both owners have released them.
      if (updates.length) {
        item.side.audio.clear()
        for (const { index } of updates) item.parts.delete(index)
      }
      let incomingBytes = 0
      for (const update of updates) if (update.knownFormat) incomingBytes += update.bytes
      const retain = total <= LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES && this.#shouldRetainAudio() &&
        this.#cachedAudioBytes() + incomingBytes <= MAX_CACHED_AUDIO_BYTES
      if (!retain && updates.length) this.#dropCachedAudio(item)
      for (const { index, audio, bytes, mimeType, sampleRate, knownFormat } of updates) {
        let buffer
        if (retain && knownFormat) {
          // Dedicated backing stores make cache accounting exact even after a
          // truncation creates a shorter view. Never expose unwritten bytes.
          const decoded = Buffer.allocUnsafeSlow(bytes)
          const written = decoded.write(audio, 0, bytes, 'base64')
          buffer = decoded.subarray(0, written)
        }
        item.parts.set(index, { bytes, buffer, mimeType, sampleRate })
      }
    }
    this.#rebuild(item, now)
    if (receivedTranscript) this.#onTranscript?.(item.id, item.side.transcript, now)
    this.#check(item.entry, now)
  }

  /**
   * @param {{ inputTimer?: ReturnType<typeof setTimeout>, waitingForTranscript: boolean }} item
   */
  #clearInputWait (item) {
    clearTimeout(item.inputTimer)
    item.inputTimer = undefined
    item.waitingForTranscript = false
  }

  /**
   * @param {{ retrievedComplete: boolean, expected: Set<number>, lastContentIndex: number,
   *   parts: Map<number, { buffer?: Buffer, bytes: number }> }} item
   */
  #hasRetrievedAudio (item) {
    if (!item.retrievedComplete) return false
    let hasAudio = false
    for (const index of item.expected) {
      if (index > item.lastContentIndex) continue
      const part = item.parts.get(index)
      if (!part?.buffer || part.buffer.length !== part.bytes) return false
      hasAudio = true
    }
    return hasAudio
  }

  /** Count owned backing allocations, including the hidden tail of truncated views. */
  #cachedAudioBytes () {
    let total = 0
    for (const item of this.#items.values()) {
      for (const part of item.parts.values()) total += part.buffer?.buffer.byteLength ?? 0
    }
    return total
  }

  /**
   * @param {{ role: string, entry?: PlaybackEntry, parts: Map<number, { buffer?: Buffer }>,
   *   side: { audio: import('./audio-accumulator') } }} item
   */
  #dropCachedAudio (item) {
    if (item.role === 'assistant' && item.entry) {
      for (const output of item.entry.output.values()) {
        for (const part of output.parts.values()) part.buffer = undefined
      }
    } else {
      for (const part of item.parts.values()) part.buffer = undefined
    }
    item.side.audio.clear()
  }

  /**
   * @param {object} item
   * @param {number} now
   */
  #rebuild (item, now) {
    const items = item.role === 'assistant' ? item.entry.output.values() : [item]
    const parts = []
    let complete = !item.entry?.audioIncomplete
    for (const owned of items) {
      if (!owned.hasAudio || owned.lastContentIndex < 0) continue
      if (owned.parts.size === 0) complete = false
      for (const index of owned.expected) {
        if (index <= owned.lastContentIndex && !owned.parts.has(index)) complete = false
      }
      for (const [index, part] of owned.parts) {
        if (index > owned.lastContentIndex) {
          owned.parts.delete(index)
          continue
        }
        const cap = owned.caps.get(index)
        const rate = bytesPerSecond(part.mimeType, part.sampleRate)
        if (cap !== undefined && rate) {
          part.bytes = Math.min(part.bytes, Math.floor(cap * rate / 1000))
          if (part.buffer) part.buffer = part.buffer.subarray(0, part.bytes)
        }
        parts.push(part)
      }
    }
    let total = 0
    const first = parts[0]
    for (const part of parts) {
      total += part.bytes
      if (part.buffer === undefined || part.mimeType !== first?.mimeType ||
          part.sampleRate !== first?.sampleRate) complete = false
    }
    if (total > LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES) {
      for (const part of parts) part.buffer = undefined
      complete = false
    }
    const buffers = []
    if (complete) for (const part of parts) buffers.push(part.buffer)
    item.side.audio.replaceBuffers(buffers, total, now,
      first?.mimeType || '', first?.sampleRate || 0)
    item.side.audio.present ||= item.role === 'assistant' ? item.entry.hasAudio : item.hasAudio
  }

  /**
   * @param {PlaybackEntry} first
   * @param {PlaybackEntry} last
   * @param {number} now
   */
  #createWindow (first, last, now) {
    const startTime = first.turn.serverSpeech?.startTime
    if (startTime === undefined || now < startTime) return
    const entries = []
    let collecting = false
    for (const entry of this.#turns.values()) {
      if (entry === first) collecting = true
      if (!collecting) continue
      if (entry.stopped || entry.playbackWindow) return
      entries.push(entry)
      if (entry === last) return { entries, startTime, finishTime: now, resolved: false }
    }
  }

  /** @param {PlaybackWindow} window */
  #deriveWindow (window) {
    if (window.resolved) return
    for (const entry of window.entries) {
      if (!entry.held) return
      for (const item of entry.output.values()) {
        if (item.wanted || item.inFlight) return
      }
    }
    window.resolved = true
    const durations = []
    let total = 0
    for (const entry of window.entries) {
      if (!entry.hasAudio) { durations.push(0); continue }
      const audio = entry.turn.audio
      const duration = segmentDurationMs(audio.totalDecodedBytes, audio.mimeType, audio.sampleRate)
      if (entry.audioIncomplete || audio.oversize || audio.chunks.length === 0 ||
          duration === undefined || duration <= 0) return
      durations.push(duration)
      total += duration
    }
    // Arrival timestamps are rounded to milliseconds. Larger inconsistencies are
    // not a consistent playback window and must leave its response boundaries unknown.
    if (total > window.finishTime - window.startTime + 1) return
    let end = window.finishTime
    for (let index = window.entries.length - 1; index >= 0; index--) {
      const duration = durations[index]
      if (!duration) continue
      const start = index === 0 ? window.startTime : Math.max(window.startTime, end - duration)
      const finish = index === 0 ? Math.max(start, Math.min(end, start + duration)) : end
      window.entries[index].turn.serverSpeech = { startTime: start, finishTime: finish, derived: true }
      end = start
    }
  }

  /**
   * @param {PlaybackWindow} window
   * @param {number} now
   * @param {PlaybackEntry} [skip] - The owner of hold() must finalize its own turn.
   */
  #checkWindow (window, now, skip) {
    this.#deriveWindow(window)
    let index = 0
    while (index < window.entries.length) {
      const entry = window.entries[index]
      if (entry === skip || !entry.held || !this.#turns.has(entry.id)) { index++; continue }
      if (this.#ready(entry)) {
        // Removal releases this member's buffers and shifts the next member into its slot.
        this.#finish(entry, now)
      } else {
        this.#arm(entry)
        index++
      }
    }
  }

  /** @param {object} entry */
  #ready (entry) {
    if (entry.playbackWindow && !entry.playbackWindow.resolved) return false
    if (entry.transcriptPending || (entry.hasAudio && !entry.stopped) ||
        (entry.cleared && !entry.truncated)) return false
    if (!this.#shouldRetainAudio()) return true
    const input = this.#items.get(entry.turn.input.itemId)
    for (const item of [input, ...entry.output.values()]) {
      if (item && item.lastContentIndex >= 0 && (item.wanted || item.inFlight)) return false
    }
    return true
  }

  /**
   * @param {object | undefined} entry
   * @param {number} now
   */
  #check (entry, now) {
    if (entry?.playbackWindow) {
      this.#checkWindow(entry.playbackWindow, now)
      return
    }
    if (!entry?.held) return
    if (this.#ready(entry)) this.#finish(entry, now)
    else this.#arm(entry)
  }

  /** @param {object} entry */
  #arm (entry) {
    clearTimeout(entry.timer)
    // A completed response without its own start can be queued behind the active
    // response. Its playback evidence cannot arrive until that shared buffer drains.
    const queued = !entry.outOfBand && entry.hasAudio && this.#active &&
      this.#active !== entry && !this.#active.stopped
    const phase = entry.stopped
      ? 'audio'
      : entry.turn.serverSpeech.startTime === undefined ? queued ? 'queued' : 'audio' : 'playback'
    if (entry.phase !== phase) {
      entry.phase = phase
      entry.deadline = Date.now() + (phase === 'audio' ? AUDIO_WAIT_MS : PLAYBACK_WAIT_MS)
    }
    entry.timer = setTimeout(() => this.#finish(entry, Date.now(), true), Math.max(0, entry.deadline - Date.now()))
    entry.timer.unref?.()
  }

  // An unstarted response loses its queue dependency when active playback ends.
  #releaseQueuedWaits () {
    if (this.#closed) return
    for (const entry of this.#turns.values()) {
      if (entry.held && entry.phase === 'queued' && entry.turn.serverSpeech.startTime === undefined) {
        this.#arm(entry)
      }
    }
  }

  /** @param {number} now */
  #evictHeld (now) {
    for (const entry of this.#turns.values()) {
      if (entry.held) {
        this.#finish(entry, now, true)
        return true
      }
    }
    return false
  }

  /**
   * @param {object} entry
   * @param {number} now
   * @param {boolean} [force]
   */
  #finish (entry, now, force = false) {
    if (!entry || !this.#turns.has(entry.id)) return
    if (force) this.#discardUnheard(entry)
    this.#remove(entry)
    this.#onReady(entry.turn, now)
  }

  /** @param {object} entry */
  #discardUnheard (entry) {
    if (!entry.stopped || (entry.cleared && !entry.truncated)) {
      entry.turn.audio.clear()
      entry.turn.audio.present = entry.hasAudio
    }
    if (!entry.stopped) entry.turn.serverSpeech = {}
  }

  /** @param {object} entry */
  #remove (entry) {
    const window = entry.playbackWindow
    if (window && !window.resolved) {
      window.resolved = true
      for (const member of window.entries) member.turn.serverSpeech = {}
    }
    if (window) {
      const index = window.entries.indexOf(entry)
      if (index !== -1) window.entries.splice(index, 1)
      entry.playbackWindow = undefined
    }
    clearTimeout(entry.timer)
    this.#turns.delete(entry.id)
    if (this.#active === entry) {
      this.#active = undefined
      this.#releaseQueuedWaits()
    }
    for (const [id, item] of this.#items) {
      if (item.entry === entry) {
        this.#clearInputWait(item)
        item.parts.clear()
        if (item.role === 'user') this.#inputs.delete(item.side)
        this.#items.delete(id)
      }
    }
    for (const [id, item] of this.#requests) {
      if (item.entry === entry) this.#requests.delete(id)
    }
  }

  /** @param {import('./turns').ResponseTurn} turn */
  #find (turn) {
    for (const entry of this.#turns.values()) if (entry.turn === turn) return entry
  }
}

module.exports = ServerPlayback
