'use strict'

const {
  bytesPerSecond,
  realtimeAudioFormatToMime,
} = require('../../../dd-trace/src/llmobs/audio-codec')
const { LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES } = require('../../../dd-trace/src/llmobs/constants/audio')
const log = require('../../../dd-trace/src/log')

const AUDIO_WAIT_MS = 5000
const PLAYBACK_WAIT_MS = 120_000
const MAX_TURNS = 128
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
  #turns = new Map()
  #items = new Map()
  #requests = new Map()
  #active
  #scheduled
  #sequence = 0
  #closed = false
  #inputFormat = { mimeType: 'audio/pcm', sampleRate: 24_000 }
  #outputFormat = { mimeType: 'audio/pcm', sampleRate: 24_000 }

  /**
   * @param {{ shouldRetainAudio: () => boolean, requestItem?: (itemId: string, eventId: string) => void,
   *   onReady: (turn: import('./turns').ResponseTurn, now: number) => void }} options
   */
  constructor ({ shouldRetainAudio, requestItem, onReady }) {
    this.#shouldRetainAudio = shouldRetainAudio
    this.#requestItem = requestItem
    this.#onReady = onReady
  }

  /**
   * @param {{ mimeType: string, sampleRate: number }} input
   * @param {{ mimeType: string, sampleRate: number }} output
   */
  updateFormats (input, output) {
    this.#inputFormat = input
    this.#outputFormat = output
  }

  /** @param {import('./turns').InputTurn} input */
  rememberInput (input) {
    if (input.itemId !== undefined) this.#bind(input.itemId, input, undefined, 'user')
  }

  /**
   * @param {string} id
   * @param {import('./turns').ResponseTurn} turn
   */
  start (id, turn) {
    if (this.#closed) return
    if (this.#turns.size >= MAX_TURNS) this.#finish(this.#turns.values().next().value, Date.now(), true)
    const entry = {
      id,
      turn,
      output: new Map(),
      held: false,
      transcriptPending: false,
      hasAudio: false,
      stopped: false,
      cleared: false,
      truncated: false,
      timer: undefined,
      deadline: undefined,
      phase: undefined,
    }
    this.#turns.set(id, entry)
    const input = this.#items.get(turn.input.itemId)
    if (input) input.entry = entry
    turn.serverSpeech = {}
  }

  /**
   * @param {string} id
   * @param {object} response
   */
  responseDone (id, response) {
    const entry = this.#turns.get(String(id))
    if (!entry || !response?.output) return
    for (const item of response.output) {
      if (item.id && item.type === 'message') this.#bindOutput(entry, item)
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
      if (entry && event.item?.type === 'message') this.#bindOutput(entry, event.item)
    } else if (type === 'conversation.item.done') {
      const item = this.#items.get(String(event.item?.id))
      if (item && this.#hasAudio(event.item)) this.#want(item)
    } else if (type === 'conversation.item.retrieved') {
      this.#retrieve(event.item, now)
    } else if (type === 'conversation.item.truncated') {
      const item = this.#items.get(String(event.item_id))
      if (item) {
        const endMs = event.audio_end_ms
        if (typeof endMs === 'number' && Number.isFinite(endMs) && endMs >= 0) {
          const index = event.content_index ?? 0
          item.caps.set(index, Math.min(item.caps.get(index) ?? endMs, endMs))
          if (item.entry) item.entry.truncated = true
          this.#rebuild(item, now)
          this.#want(item)
          this.#check(item.entry, now)
        }
      }
    } else if (type === 'output_audio_buffer.started') {
      const entry = this.#turns.get(String(event.response_id))
      if (entry) {
        entry.hasAudio = true
        entry.turn.serverSpeech.startTime ??= now
        if (this.#active && this.#active !== entry) {
          const previous = this.#active
          previous.ambiguous = entry.ambiguous = true
          previous.stopped = true
          previous.turn.serverSpeech = {}
          this.#check(previous, now)
        }
        this.#active = entry
      }
    } else if (type === 'output_audio_buffer.stopped' || type === 'output_audio_buffer.cleared') {
      const entry = this.#turns.get(String(event.response_id))
      if (this.#active && this.#active !== entry) {
        // A continuous playback interval across responses has no per-response split.
        // AIDEV-NOTE: omit ambiguous speech spans instead of inventing a boundary.
        const active = this.#active
        active.ambiguous = true
        active.stopped = true
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
    } else if (type === 'error') {
      const item = this.#requests.get(String(event.error?.event_id))
      if (item) {
        item.inFlight = item.wanted = false
        item.failed = true
        this.#check(item.entry, now)
      }
    }
  }

  /** @param {number} now */
  finishSession (now) {
    this.#closed = true
    clearImmediate(this.#scheduled)
    for (const entry of this.#turns.values()) this.#finish(entry, now, true)
    this.#items.clear()
    this.#requests.clear()
  }

  /** @param {object} message */
  #hasAudio (message) {
    return message?.content?.some(part => ['audio', 'input_audio', 'output_audio'].includes(part.type))
  }

  /**
   * @param {object} entry
   * @param {object} message
   */
  #bindOutput (entry, message) {
    if (typeof message.id !== 'string' || !message.id) return
    const item = this.#bind(message.id, entry.turn, entry, 'assistant')
    entry.output.set(item.id, item)
    if (this.#hasAudio(message)) {
      entry.hasAudio = true
      entry.turn.audio.present = true
      if (message.status === 'completed') this.#want(item)
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
      if (this.#items.size >= MAX_ITEMS) {
        const oldest = this.#items.values().next().value
        if (oldest.entry) this.#finish(oldest.entry, Date.now(), true)
        else this.#items.delete(oldest.id)
      }
      item = {
        id,
        side,
        entry,
        role,
        parts: new Map(),
        caps: new Map(),
        inFlight: false,
        wanted: false,
        attempts: 0,
        failed: false,
      }
      this.#items.set(id, item)
    }
    if (entry) item.entry = entry
    return item
  }

  /** @param {object} item */
  #want (item) {
    if (item.failed || item.attempts >= 2 || !this.#shouldRetainAudio() || !this.#requestItem) return
    if (item.inFlight) return
    item.wanted = true
    if (this.#scheduled || this.#closed) return
    this.#scheduled = setImmediate(() => {
      this.#scheduled = undefined
      for (const candidate of this.#items.values()) {
        if (!candidate.wanted || candidate.inFlight) continue
        candidate.wanted = false
        if (!this.#shouldRetainAudio()) { this.#check(candidate.entry, Date.now()); continue }
        const eventId = 'ddtrace_realtime_audio_' + (++this.#sequence)
        candidate.inFlight = true
        candidate.attempts++
        this.#requests.set(eventId, candidate)
        try {
          this.#requestItem(candidate.id, eventId)
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
    item.inFlight = item.wanted = false
    let index = 0
    if (message.content) {
      for (const part of message.content) {
        if (typeof part.audio === 'string') {
          const fallback = item.role === 'user' ? this.#inputFormat : this.#outputFormat
          const mimeType = part.format ? realtimeAudioFormatToMime(part.format) : fallback.mimeType
          const sampleRate = typeof part.format?.rate === 'number' ? part.format.rate : fallback.sampleRate
          const cap = item.caps.get(index)
          const rate = bytesPerSecond(mimeType, sampleRate)
          const count = Buffer.byteLength(part.audio, 'base64')
          const bytes = cap === undefined || !rate ? count : Math.min(count, Math.floor(cap * rate / 1000))
          const retained = bytes <= LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES && this.#shouldRetainAudio()
            ? Buffer.from(part.audio.slice(0, Math.ceil(bytes / 3) * 4), 'base64').subarray(0, bytes)
            : undefined
          item.parts.set(index, { bytes, buffer: retained, mimeType, sampleRate })
        }
        if (item.role === 'user' && part.transcript && !item.side.transcript) item.side.transcript = part.transcript
        index++
      }
    }
    this.#rebuild(item, now)
    this.#check(item.entry, now)
  }

  /**
   * @param {object} item
   * @param {number} now
   */
  #rebuild (item, now) {
    const items = item.role === 'assistant' ? item.entry.output.values() : [item]
    const parts = []
    for (const owned of items) {
      for (const [index, part] of owned.parts) {
        const cap = owned.caps.get(index)
        const rate = bytesPerSecond(part.mimeType, part.sampleRate)
        if (cap !== undefined && rate) {
          part.bytes = Math.min(part.bytes, Math.floor(cap * rate / 1000))
          if (part.buffer) part.buffer = part.buffer.subarray(0, part.bytes)
        }
        parts.push(part)
      }
    }
    const total = parts.reduce((sum, part) => sum + part.bytes, 0)
    if (total > LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES) {
      for (const part of parts) part.buffer = undefined
    }
    const first = parts[0]
    const complete = parts.every(part => part.buffer !== undefined &&
      part.mimeType === first?.mimeType && part.sampleRate === first?.sampleRate)
    item.side.audio.replaceBuffers(complete ? parts.map(part => part.buffer) : [], total, now,
      first?.mimeType || '', first?.sampleRate || 0)
  }

  /** @param {object} entry */
  #ready (entry) {
    if (entry.transcriptPending || (entry.hasAudio && !entry.stopped) ||
        (entry.cleared && !entry.truncated)) return false
    if (!this.#shouldRetainAudio()) return true
    const input = this.#items.get(entry.turn.input.itemId)
    for (const item of [input, ...entry.output.values()]) {
      if (item && (item.wanted || item.inFlight)) return false
    }
    return true
  }

  /**
   * @param {object | undefined} entry
   * @param {number} now
   */
  #check (entry, now) {
    if (!entry?.held) return
    if (this.#ready(entry)) this.#finish(entry, now)
    else this.#arm(entry)
  }

  /** @param {object} entry */
  #arm (entry) {
    clearTimeout(entry.timer)
    const phase = entry.hasAudio && !entry.stopped ? 'playback' : 'audio'
    if (entry.phase !== phase) {
      entry.phase = phase
      entry.deadline = Date.now() + (phase === 'playback' ? PLAYBACK_WAIT_MS : AUDIO_WAIT_MS)
    }
    entry.timer = setTimeout(() => this.#finish(entry, Date.now(), true), Math.max(0, entry.deadline - Date.now()))
    entry.timer.unref?.()
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
    clearTimeout(entry.timer)
    this.#turns.delete(entry.id)
    if (this.#active === entry) this.#active = undefined
    for (const [id, item] of this.#items) {
      if (item.entry === entry) this.#items.delete(id)
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
