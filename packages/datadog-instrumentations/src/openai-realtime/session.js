'use strict'

const { randomUUID } = require('node:crypto')

const {
  bytesPerSecond,
  realtimeAudioFormatToMime,
  segmentDurationMs,
} = require('../../../dd-trace/src/llmobs/audio-codec')
const log = require('../../../dd-trace/src/log')
const { extractResponseTools, normalizeResponseEventType } = require('./events')
const { InputTurn, ResponseTurn } = require('./turns')

// Realtime PCM is 24 kHz mono by spec; overridden from the session's format object when present.
const DEFAULT_AUDIO_RATE = 24_000

// Ceiling on how long a finished turn is held waiting for its audio to finish playing. A connection
// that goes idle right after a response is the gap: nothing fires, so the held turn would wait for
// the next event or for close. A timed flush is deliberately avoided — it would finalize turns off
// the caller's thread, and this state machine is only safe because every path runs on it.
const PARK_MAX_MS = 5000

// How many un-acknowledged `response.create`s to remember. Each is matched off by the next
// `response.created`, so the queue is normally empty or holds one; the bound only stops a client
// whose creates are rejected — the server answers with `error`, which carries no response id — from
// growing it across a long connection.
const MAX_PENDING_RESPONSE_CREATES = 8

/**
 * @typedef {import('./turns').ResponseTurn} Turn
 * @typedef {import('./turns').ToolCall} ToolCall
 * @typedef {import('./turns').ToolResult} ToolResult
 *
 * @typedef {{
 *   startTime: number,
 *   finishTime: number,
 *   transcript: string,
 * }} SpeechWindow
 *
 * @typedef {{
 *   text: string,
 *   transcript: string,
 *   audio: Buffer,
 *   audioPresent: boolean,
 *   mimeType: string,
 *   sampleRate: number,
 *   toolCalls?: ToolCall[],
 *   toolResults: ToolResult[],
 * }} TurnSide
 *
 * @typedef {{
 *   sessionId: string,
 *   model: string | undefined,
 *   basePath: string,
 *   metadata: Record<string, unknown>,
 *   usage: object | undefined,
 *   failed: boolean,
 *   error: { type?: string, code?: string, message?: string } | undefined,
 *   runInContext: ((fn: () => void) => void) | undefined,
 *   root: { startTime: number, finishTime: number },
 *   llm: { startTime: number, finishTime: number },
 *   userSpeech: SpeechWindow | undefined,
 *   agentSpeech: SpeechWindow | undefined,
 *   input: TurnSide,
 *   output: TurnSide,
 * }} TurnDescriptor
 */

/**
 * Coerce a value the server sent to a finite number, or `undefined`.
 *
 * @param {unknown} value
 * @returns {number | undefined}
 */
function toFiniteNumber (value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

/**
 * Flatten the provider's failure detail to plain strings, or `undefined` when it said nothing
 * usable. Kept to the three fields OpenAI documents so a span carries the type and message a
 * responder actually needs, without copying an arbitrary provider object onto a tag.
 *
 * @param {unknown} error
 */
function providerError (error) {
  if (error === null || typeof error !== 'object') return

  /** @type {{ type?: string, code?: string, message?: string }} */
  const flattened = {}
  let reported = false
  for (const field of ['type', 'code', 'message']) {
    if (error[field] == null) continue
    flattened[field] = String(error[field])
    reported = true
  }

  return reported ? flattened : undefined
}

/**
 * The audio format to interpret a segment with: the one recorded when its first frame arrived,
 * falling back to the session's current format.
 *
 * The fallback covers a segment that never recorded one — it holds no audio, or the session had not
 * announced a format yet — and is not the mutable-format case: a segment that did record a format
 * keeps it, so a later `session.update` cannot retime bytes that arrived under the old one.
 *
 * @param {import('./audio-accumulator')} audio
 * @param {string} mimeType
 * @param {number} sampleRate
 * @returns {{ mimeType: string, sampleRate: number }}
 */
function segmentFormat (audio, mimeType, sampleRate) {
  return { mimeType: audio.mimeType || mimeType, sampleRate: audio.sampleRate || sampleRate }
}

/**
 * Drives per-turn spans off one realtime connection's event stream.
 *
 * Turns are accumulated as plain data and replayed as a back-dated span tree at finalize, so nothing
 * is held open across a deferred finalize (a late input transcription, or audio still playing) and a
 * dropped connection cannot leak an unfinished span.
 */
class RealtimeSession {
  /** Per-connection id grouping every turn of this conversation in the UI. */
  #sessionId = randomUUID().replaceAll('-', '')

  /** @type {(descriptor: TurnDescriptor) => void} */
  #emitTurn

  /** @type {(turn: Turn) => void} */
  #captureContext

  /** @type {string | undefined} */
  #model

  /** @type {string} */
  #basePath

  /** @type {Record<string, unknown>} */
  #sessionConfig = {}

  #inputAudioMime = ''
  #outputAudioMime = ''
  #inputAudioRate = DEFAULT_AUDIO_RATE
  #outputAudioRate = DEFAULT_AUDIO_RATE

  /**
   * Whether the session enabled input-audio transcription. A turn's finalize is only deferred to
   * wait for a transcript when one is actually configured — otherwise none is ever coming.
   */
  #inputTranscriptionEnabled = false

  /**
   * Offset (ms) of the end of all input audio appended this session, and the wall clock (epoch ms)
   * at which we reached it. Together they place a VAD event's buffer offset on the wall clock.
   */
  #inputBufferMs = 0
  /** @type {number | undefined} */
  #inputBufferMsAt = undefined

  /**
   * Bytes appended before the audio format was known — a client streaming from its own thread can
   * beat `session.created`. Held as a backlog and folded into the clock once a rate arrives, rather
   * than writing the origin off and disabling onset projection for the whole session.
   */
  #pendingInputBytes = 0

  /**
   * Whether anything consumes the captured audio. Only LLM Observability does, so with it disabled
   * — the default — the segments keep their byte counts, which size the speech windows, and hold no
   * bytes. See `AudioAccumulator`.
   */
  #retainAudio

  /** @type {InputTurn} */
  #pendingInput

  /**
   * One entry per client `response.create` still waiting for its `response.created`, recording
   * whether that response supplies its own input and the client event id a server `error` would
   * name. FIFO: the server acknowledges creates in order.
   *
   * @type {Array<{ outOfBand: boolean, eventId: string | undefined }>}
   */
  #responseCreates = []

  /** @type {Map<string, Turn>} */
  #responses = new Map()

  /** @type {Map<string, string>} */
  #inputTranscripts = new Map()

  /** call_id -> function name, so a later `function_call_output` can be labeled with its tool name. */
  #toolCallNames = new Map()

  /**
   * Turns whose response is done but whose input transcription hasn't arrived yet.
   *
   * @type {Turn[]}
   */
  #awaiting = []

  /**
   * Finished turns held open while their audio is still playing, so a barge-in truncation can still
   * cap them.
   *
   * @type {Turn[]}
   */
  #playing = []

  /**
   * Whether this connection's client has ever truncated — which is what makes holding turns open
   * worth its cost. A client either implements barge-in or it does not.
   */
  #clientTruncates = false

  #closed = false

  /**
   * @param {object} options
   * @param {(descriptor: TurnDescriptor) => void} options.emitTurn
   * @param {(turn: Turn) => void} options.captureContext
   * @param {string} [options.model]
   * @param {string} [options.basePath]
   * @param {boolean} [options.retainAudio]
   */
  constructor ({ emitTurn, captureContext, model, basePath = '', retainAudio = true }) {
    this.#emitTurn = emitTurn
    this.#captureContext = captureContext
    this.#model = model
    this.#basePath = basePath
    this.#retainAudio = retainAudio
    this.#pendingInput = new InputTurn(retainAudio)
  }

  // -- event entry points ---------------------------------------------------

  /**
   * @param {Record<string, unknown>} event
   * @param {number} now - Epoch ms at which the event was observed.
   */
  onClientEvent (event, now) {
    try {
      this.#flushPlaying(now)

      switch (event?.type) {
        // First: a server-VAD client appends microphone audio many times a second.
        case 'input_audio_buffer.append':
          if (event.audio) this.#appendInputAudio(event.audio, now)
          break
        case 'conversation.item.truncate':
          // Client -> server: "the listener only got this far into that item."
          this.#onTruncate(event.item_id, event.audio_end_ms, now)
          break
        case 'session.update':
          this.#updateSessionConfig(event.session)
          break
        case 'input_audio_buffer.clear':
          // Discarded input audio must not be attributed to the next response.
          this.#pendingInput.discardAudio()
          break
        case 'conversation.item.create':
          this.#absorbInputItem(event.item, now)
          break
        case 'response.create':
          this.#onResponseCreate(event.response, event.event_id)
          break
      }
    } catch (error) {
      log.debug('Error handling OpenAI realtime client event: %s', error?.message)
    }
  }

  /**
   * @param {Record<string, unknown>} event
   * @param {number} now - Epoch ms at which the event was observed.
   */
  onServerEvent (event, now) {
    try {
      this.#flushPlaying(now)

      const eventType = event?.type
      if (typeof eventType !== 'string') return

      switch (eventType) {
        case 'session.created':
        case 'session.updated':
          this.#updateSessionConfig(event.session)
          return
        case 'conversation.item.truncated':
          // The server's acknowledgement of a client truncation. `capTo` is absolute, so handling
          // both it and the client event applies the cap once.
          this.#onTruncate(event.item_id, event.audio_end_ms, now)
          return
        case 'input_audio_buffer.speech_started':
          this.#onSpeechStarted(event.audio_start_ms, now)
          return
        case 'input_audio_buffer.speech_stopped':
          // The commit that follows is the authoritative end of user speech and overwrites this;
          // recording it here only covers a session that never commits, so the window still gets an
          // end.
          this.#pendingInput.speechEndTime ??= now
          return
        case 'input_audio_buffer.committed':
          this.#pendingInput.itemId = event.item_id == null ? undefined : String(event.item_id)
          this.#pendingInput.speechEndTime = now
          return
        case 'input_audio_buffer.cleared':
          this.#pendingInput.discardAudio()
          return
        case 'conversation.item.input_audio_transcription.completed':
          this.#onInputTranscript(event.item_id, event.transcript, now)
          return
        case 'conversation.item.input_audio_transcription.failed':
          // No transcription is coming for this item. Recorded as an empty transcript rather than
          // just flushing whatever is already waiting: this can land *before* the response's
          // `response.done`, and without the record `#finishResponse` would then park the turn for
          // an event that has already happened.
          this.#onInputTranscript(event.item_id, '', now)
          return
        case 'response.created':
          this.#startResponse(event.response?.id ?? event.response_id, now)
          return
        case 'response.done':
          this.#finishResponse(event.response?.id ?? event.response_id, event.response, now)
          return
        case 'error':
          // A rejected `response.create` never produces the `response.created` its queue entry is
          // waiting for, so retire it before it misclassifies the next response.
          this.#discardFailedResponseCreate(event.error)
          return
        default:
          this.#handleResponseDelta(event, eventType, now)
      }
    } catch (error) {
      log.debug('Error handling OpenAI realtime server event: %s', error?.message)
    }
  }

  /**
   * Finalize everything still open. Idempotent, so every close path can call it.
   *
   * @param {number} now - Epoch ms.
   * @param {boolean} [failed] - The connection ended abnormally. Only responses still in flight are
   *   marked: a turn already awaiting a transcript or playback had its `response.done`, so it
   *   succeeded whatever the transport did afterwards.
   */
  finishSession (now, failed = false) {
    if (this.#closed) return
    this.#closed = true

    try {
      this.#flushAwaiting(now)
      this.#flushPlaying(now, true)

      // In-flight turns that never saw `response.done` (closed mid-turn). Whatever partial data we
      // have is submitted.
      for (const turn of this.#responses.values()) {
        if (failed) turn.status = 'failed'
        this.#applyCachedTranscript(turn)
        this.#finalizeTurn(turn, now, true)
      }

      this.#responses.clear()
      this.#inputTranscripts.clear()
      this.#toolCallNames.clear()
      // Audio buffered for a turn that will now never start. An app that holds on to closed
      // transport objects keeps their sessions reachable through the connection map, and a
      // server-VAD client streams the microphone continuously, so this is up to the whole retention
      // cap per closed connection with nothing left to consume it.
      this.#pendingInput = new InputTurn(this.#retainAudio)
    } catch (error) {
      log.debug('Error finalizing OpenAI realtime session: %s', error?.message)
    }
  }

  // -- response deltas ------------------------------------------------------

  /**
   * @param {Record<string, unknown>} event
   * @param {string} eventType
   * @param {number} now
   */
  #handleResponseDelta (event, eventType, now) {
    const turn = this.#responses.get(String(event.response_id))
    if (turn === undefined) return

    switch (normalizeResponseEventType(eventType)) {
      case 'response.audio.delta': {
        const { delta, item_id: itemId } = event
        if (!delta) return
        if (itemId != null) {
          // Remember where this item's audio starts in the turn's segment, before appending, so a
          // truncation reported against the item maps onto the segment.
          const key = String(itemId)
          if (!turn.audioItemStarts.has(key)) turn.audioItemStarts.set(key, turn.audio.totalDecodedBytes)
        }
        turn.audio.append(delta, now, this.#outputAudioMime, this.#outputAudioRate)
        return
      }
      case 'response.audio_transcript.delta':
        turn.transcript.appendDelta(event.item_id, event.delta ?? '')
        return
      case 'response.audio_transcript.done':
        if (event.transcript != null) turn.transcript.complete(event.item_id, String(event.transcript))
        return
      case 'response.text.delta':
        turn.text.appendDelta(event.item_id, event.delta ?? '')
        return
      case 'response.text.done':
        if (event.text != null) turn.text.complete(event.item_id, String(event.text))
    }
  }

  // -- input audio and the speech window ------------------------------------

  /**
   * Buffer a client audio append for the pending turn and advance the input-buffer clock.
   *
   * @param {string} base64
   * @param {number} now
   */
  #appendInputAudio (base64, now) {
    const pending = this.#pendingInput

    // Fold in anything buffered before the format was known first, so the base offset captured below
    // sits on the same timeline the VAD offsets are later projected against.
    this.#advanceInputBufferClock(0, now)

    if (pending.audio.startTime === undefined && this.#inputBufferMsAt !== undefined) {
      // First frame of this turn and the clock is live: remember where it sits on the session's
      // input-buffer timeline, so a VAD offset can be turned into a byte offset into what we buffer
      // here. Left unset while the clock is dead, since a base of 0 would read as "this turn starts
      // at the session origin" and over-trim the front of the segment.
      pending.audioBaseMs = this.#inputBufferMs
    }

    const decodedBytes = pending.audio.append(base64, now, this.#inputAudioMime, this.#inputAudioRate)
    this.#advanceInputBufferClock(decodedBytes, now)
  }

  /**
   * Track how far into the session's input audio the buffer now extends, and when we got there.
   *
   * @param {number} decodedBytes
   * @param {number} now
   */
  #advanceInputBufferClock (decodedBytes, now) {
    this.#pendingInputBytes += decodedBytes

    const rate = bytesPerSecond(this.#inputAudioMime, this.#inputAudioRate)
    // A format we can never rate leaves the projection unavailable: the backlog simply never
    // converts and `#inputBufferMsAt` stays undefined, which is what marks the clock dead.
    if (!rate) return

    this.#inputBufferMs += this.#pendingInputBytes / rate * 1000
    this.#pendingInputBytes = 0
    this.#inputBufferMsAt = now
  }

  /**
   * Anchor the pending turn's user-speech window on the VAD speech onset.
   *
   * A server-VAD client streams the microphone continuously, so the first buffer append of a turn
   * lands the instant the *previous* turn was committed: it marks when we started listening, not
   * when the human started speaking. Left at that, every user-speech window swallows the whole
   * preceding agent response and consecutive turns overlap on the session timeline.
   * `input_audio_buffer.speech_started` is the real onset, and the audio it points at
   * (`audio_start_ms`, which already includes the session's `prefix_padding_ms`) is the audio worth
   * keeping, so the buffered lead-in is trimmed off the front to keep the captured audio and the
   * reported window in step.
   *
   * Only the first onset of a turn counts: a turn that VAD splits into several speech runs before a
   * single commit is still one committed item, which began at the first run.
   *
   * @param {unknown} audioStartMs
   * @param {number} now
   */
  #onSpeechStarted (audioStartMs, now) {
    const pending = this.#pendingInput
    if (pending.speechStartTime !== undefined) return

    const onset = this.#bufferOffsetToWallTime(audioStartMs, now)
    pending.speechStartTime = onset

    pending.audio.trimLeading(this.#preOnsetBytes(audioStartMs))
    // Re-anchor the segment on the onset: whatever survived the trim starts there. A trim that
    // covered the whole segment resets it instead, and re-anchoring then would leave `startTime`
    // set with no format recorded — `append` only records the format on the frame that opens a
    // segment, so every later frame would skip it and the segment would fall back to whatever
    // format the session holds at describe time.
    if (pending.audio.startTime !== undefined) pending.audio.startTime = onset
  }

  /**
   * Byte count of the audio buffered for this turn ahead of the speech onset.
   *
   * @param {unknown} audioStartMs
   */
  #preOnsetBytes (audioStartMs) {
    const baseMs = this.#pendingInput.audioBaseMs
    const onsetMs = toFiniteNumber(audioStartMs)
    const rate = bytesPerSecond(this.#inputAudioMime, this.#inputAudioRate)
    if (baseMs === undefined || onsetMs === undefined || !rate) return 0

    const bytes = Math.max(0, Math.trunc((onsetMs - baseMs) / 1000 * rate))
    // Cut on a sample boundary, as the truncation cap does: `audioBaseMs` is a fractional millisecond
    // offset, so this lands on an odd byte often enough to matter, and slicing a PCM16 segment
    // mid-sample pairs every low byte with the next sample's high byte — the whole clip decodes to
    // noise. Rounding down keeps a byte of lead-in rather than corrupting what follows.
    return bytes - bytes % 2 // keep PCM16 samples whole; a byte is nothing for G.711
  }

  /**
   * Project an input-buffer offset — a VAD event's `audio_start_ms`, measured from the start of all
   * audio written to the buffer this session — onto the wall clock.
   *
   * This assumes the client appends audio roughly in real time, which is true for a live microphone,
   * the only case where a wall-clock speech window means anything. Knowing how much audio had been
   * appended at a known instant, the offset is that instant minus the audio still ahead of it. The
   * result is clamped to a window we can defend — no earlier than this turn's first buffered frame,
   * no later than when we observed the event — so a bursty or pre-recorded sender degrades to a sane
   * bound instead of a wild timestamp, and falls back to the observation time when the projection is
   * unavailable.
   *
   * @param {unknown} offsetMs
   * @param {number} observedTime
   */
  #bufferOffsetToWallTime (offsetMs, observedTime) {
    const offset = toFiniteNumber(offsetMs)
    if (offset === undefined || this.#inputBufferMsAt === undefined) return observedTime

    let projected = this.#inputBufferMsAt - (this.#inputBufferMs - offset)

    const earliest = this.#pendingInput.audio.startTime
    if (earliest !== undefined) projected = Math.max(projected, earliest)

    return Math.min(projected, observedTime)
  }

  // -- barge-in (agent playback cut short) ----------------------------------

  /**
   * Cap an assistant audio segment at what the listener actually heard.
   *
   * Over a WebSocket the client owns playback and the model streams audio faster than it plays, so
   * on a barge-in the client stops its speaker and reports how far it got. Audio delivered past that
   * point was never heard; without this the stored agent audio — and the agent-speech window derived
   * from it — covers the whole generated response and runs past the interruption into the next user
   * turn.
   *
   * Seeing a truncation also marks this connection's client as one that cuts playback short, which
   * is what makes holding its turns open worthwhile.
   *
   * @param {unknown} itemId
   * @param {unknown} audioEndMs
   * @param {number} now
   */
  #onTruncate (itemId, audioEndMs, now) {
    this.#clientTruncates = true

    const endMs = toFiniteNumber(audioEndMs)
    if (itemId == null || endMs === undefined) return

    const item = String(itemId)
    for (const turn of this.#openTurns()) {
      const itemStart = turn.audioItemStarts.get(item)
      if (itemStart === undefined) continue

      const { mimeType, sampleRate } = segmentFormat(turn.audio, this.#outputAudioMime, this.#outputAudioRate)
      const rate = bytesPerSecond(mimeType, sampleRate)
      if (!rate) return

      const cap = itemStart + Math.trunc(endMs / 1000 * rate)
      turn.audio.capTo(cap - cap % 2) // keep PCM16 samples whole; a byte is nothing for G.711

      const playingIndex = this.#playing.indexOf(turn)
      if (playingIndex !== -1) {
        // Playback ended when the listener cut it off, so stop waiting on it.
        this.#playing.splice(playingIndex, 1)
        this.#finalizeTurn(turn, now, true)
      }
      return
    }
  }

  /**
   * Every turn we could still amend: in flight, awaiting a transcript, or awaiting playback.
   *
   * @returns {Turn[]}
   */
  #openTurns () {
    return [...this.#responses.values(), ...this.#awaiting, ...this.#playing]
  }

  /**
   * Hold a finished turn while its audio is still playing, so a late truncation can still cap it.
   *
   * `response.done` normally lands mid-playback (generation outruns playback), and a barge-in
   * truncation arrives after that — too late for a turn we already submitted. Holding costs
   * submission latency and a wider window in which to lose the turn if the process dies, so we only
   * hold on connections whose client has actually truncated before. Clients that never truncate hear
   * every byte we captured and finalize at `response.done` exactly as before, paying nothing. The
   * cost of that trade is that the first interruption on a connection is reported untruncated.
   *
   * Reports whether the turn was parked, so the caller knows not to finalize it.
   *
   * @param {Turn} turn
   * @param {number} now
   */
  #parkForPlayback (turn, now) {
    if (!this.#clientTruncates || turn.audio.startTime === undefined) return false

    const { mimeType, sampleRate } = segmentFormat(turn.audio, this.#outputAudioMime, this.#outputAudioRate)
    const playbackMs = segmentDurationMs(turn.audio.totalDecodedBytes, mimeType, sampleRate)
    if (playbackMs === undefined) return false

    const endTime = turn.audio.startTime + playbackMs
    if (endTime <= now) return false

    turn.playbackEndTime = Math.min(endTime, now + PARK_MAX_MS)
    this.#playing.push(turn)
    return true
  }

  /**
   * Finalize held turns whose audio has finished playing, or all of them when forced.
   *
   * Event-driven rather than timed: a realtime connection is chatty — a streaming client appends
   * microphone audio continuously — so this runs often enough to submit a turn shortly after its
   * playback ends, and the next turn and connection close both force it so a turn can't leak.
   *
   * @param {number} now
   * @param {boolean} [force]
   */
  #flushPlaying (now, force = false) {
    if (this.#playing.length === 0) return

    for (let i = this.#playing.length - 1; i >= 0; i--) {
      const turn = this.#playing[i]
      if (!force && turn.playbackEndTime !== undefined && turn.playbackEndTime > now) continue

      this.#playing.splice(i, 1)
      this.#finalizeTurn(turn, now, true)
    }
  }

  // -- turn lifecycle -------------------------------------------------------

  /**
   * Note a client-initiated response, so the `response.created` it produces knows whether it owns
   * the buffered user input.
   *
   * A response that carries its own `input`, or that is explicitly out-of-band
   * (`conversation: 'none'`), is not the user's turn — the app is asking the model something on the
   * side, which OpenAI supports running in parallel with the conversation. Letting it consume the
   * pending input would attribute the user's microphone audio and transcript to it *and* leave the
   * next real turn with nothing, dropping that turn's user-speech span entirely.
   *
   * @param {Record<string, unknown> | undefined} response
   * @param {unknown} eventId - The client event's own `event_id`, when it set one, so a server
   *   `error` naming it can retire this entry.
   */
  #onResponseCreate (response, eventId) {
    if (this.#responseCreates.length >= MAX_PENDING_RESPONSE_CREATES) this.#responseCreates.shift()

    this.#responseCreates.push({
      outOfBand: Array.isArray(response?.input) || response?.conversation === 'none',
      eventId: eventId == null ? undefined : String(eventId),
    })
  }

  /**
   * Retire the queue entry for a `response.create` the server rejected.
   *
   * A rejected create never produces a `response.created` — the server answers with `error` — so its
   * entry would otherwise be consumed by the *next* response and misclassify it. Getting that wrong
   * in the out-of-band direction is the expensive one: a genuine turn would be handed a fresh
   * `InputTurn` and lose the user speech it had buffered.
   *
   * `error.event_id` names the client event at fault when the app set one, which resolves this
   * exactly: an error naming some other event (a bad audio append, say) means no create failed and
   * the queue is left alone. Without an id there is nothing to correlate on, so the most recent
   * create is retired — the errors that reach this state are overwhelmingly about the create just
   * sent, and being wrong merely restores the pre-existing behaviour of treating the next response as
   * conversational.
   *
   * @param {Record<string, unknown> | undefined} error
   */
  #discardFailedResponseCreate (error) {
    if (this.#responseCreates.length === 0) return

    const eventId = error?.event_id
    if (eventId != null) {
      const index = this.#responseCreates.findIndex(create => create.eventId === String(eventId))
      if (index !== -1) this.#responseCreates.splice(index, 1)
      return
    }

    this.#responseCreates.pop()
  }

  /**
   * @param {unknown} responseId
   * @param {number} now
   */
  #startResponse (responseId, now) {
    if (responseId == null) return

    // An empty queue means the server created this response on its own — server VAD deciding the
    // user finished speaking — which is exactly the case that owns the pending input. Classify
    // before flushing: an out-of-band response runs *alongside* the conversation, so it is not
    // evidence that a pending turn's transcript has stopped coming.
    const outOfBand = this.#responseCreates.shift()?.outOfBand === true

    if (!outOfBand) {
      // A new conversational turn starting means a prior turn's input transcription is almost
      // certainly not coming anymore, and that any held playback is over (or was cut off without a
      // truncation reaching us), so flush both rather than let a turn hang.
      this.#flushAwaiting(now)
      this.#flushPlaying(now, true)
    }

    const input = outOfBand ? new InputTurn(this.#retainAudio) : this.#pendingInput
    const turn = new ResponseTurn(input, now, this.#retainAudio)
    if (!outOfBand) this.#pendingInput = new InputTurn(this.#retainAudio)
    turn.model = this.#model

    this.#captureContext(turn)
    this.#responses.set(String(responseId), turn)
  }

  /**
   * @param {unknown} responseId
   * @param {Record<string, unknown>} response
   * @param {number} now
   */
  #finishResponse (responseId, response, now) {
    if (responseId == null) return

    const key = String(responseId)
    const turn = this.#responses.get(key)
    if (turn === undefined) return
    this.#responses.delete(key)

    turn.responseDoneTime = now
    turn.usage = response?.usage
    turn.model = response?.model || turn.model || this.#model
    turn.status = response?.status
    // The provider's actionable detail for a failure. Without it a failed turn reaches the backend
    // as a bare `error: 1`, which says a realtime call broke but nothing about why.
    turn.error = providerError(response?.status_details?.error)

    const { toolCalls, toolResults } = extractResponseTools(response)
    turn.toolCalls = toolCalls
    turn.toolResults = toolResults
    // Remember each function call's name so the `function_call_output` the app returns later can be
    // labeled with it — the output event itself only carries the call_id.
    for (const toolCall of toolCalls) {
      if (toolCall.type === 'function' && toolCall.toolId) {
        this.#toolCallNames.set(toolCall.toolId, toolCall.name)
      }
    }

    this.#applyCachedTranscript(turn)

    // Hold the turn open for a late input transcription ONLY when transcription is actually enabled
    // and this item has not already reached a terminal state: otherwise no transcript is ever
    // coming, and waiting would needlessly delay every turn until the next one, and the last turn
    // until close. A cached entry — including the empty string a completion-with-no-text or a
    // failure records — is that terminal state, and it is why the check is `has` rather than the
    // transcript's truthiness.
    if (!turn.input.transcript &&
        turn.input.itemId !== undefined &&
        this.#inputTranscriptionEnabled &&
        !this.#inputTranscripts.has(turn.input.itemId)) {
      this.#awaiting.push(turn)
      return
    }

    this.#finalizeTurn(turn, now)
  }

  /**
   * @param {unknown} itemId
   * @param {unknown} transcript
   * @param {number} now
   */
  #onInputTranscript (itemId, transcript, now) {
    const item = itemId == null ? undefined : String(itemId)
    const text = transcript == null ? '' : String(transcript)

    if (item !== undefined) this.#inputTranscripts.set(item, text)
    if (this.#pendingInput.itemId === item && !this.#pendingInput.transcript) {
      this.#pendingInput.transcript = text
    }

    // A finished turn may have been waiting on exactly this transcript — finalize it now.
    this.#finalizeAwaitingFor(itemId, now, text)
  }

  /**
   * @param {unknown} itemId
   * @param {number} now
   * @param {string} [transcript]
   */
  #finalizeAwaitingFor (itemId, now, transcript) {
    if (itemId == null) return
    const item = String(itemId)

    for (let i = this.#awaiting.length - 1; i >= 0; i--) {
      const turn = this.#awaiting[i]
      if (turn.input.itemId !== item) continue

      if (transcript) turn.input.transcript ||= transcript
      this.#awaiting.splice(i, 1)
      this.#finalizeTurn(turn, now)
    }
  }

  /**
   * @param {number} now
   */
  #flushAwaiting (now) {
    if (this.#awaiting.length === 0) return

    const awaiting = this.#awaiting
    this.#awaiting = []
    for (const turn of awaiting) this.#finalizeTurn(turn, now, true)
  }

  /**
   * @param {Turn} turn
   */
  #applyCachedTranscript (turn) {
    if (turn.input.transcript || turn.input.itemId === undefined) return
    turn.input.transcript = this.#inputTranscripts.get(turn.input.itemId) ?? ''
  }

  /**
   * @param {Turn} turn
   * @param {number} now
   * @param {boolean} [force] - Skip parking, for the paths that must not wait (close, next turn).
   */
  #finalizeTurn (turn, now, force = false) {
    // The turn's data is complete, but on a barge-in-capable client the agent's audio may still be
    // playing and a truncation may yet cut it short — hold the turn rather than submit audio the
    // listener might never hear.
    if (!force && this.#parkForPlayback(turn, now)) return

    // Drop the cached transcript for this turn's input item so the map can't grow across a long
    // session. Every finalize path goes through here.
    if (turn.input.itemId !== undefined) this.#inputTranscripts.delete(turn.input.itemId)

    try {
      this.#emitTurn(this.#describeTurn(turn, now))
    } catch (error) {
      log.debug('Error emitting OpenAI realtime turn spans: %s', error?.message)
    }
  }

  /**
   * Flatten a finished turn into the boundaries and payloads the plugins need, so they never reach
   * into this class's state.
   *
   * @param {Turn} turn
   * @param {number} now
   * @returns {TurnDescriptor}
   */
  #describeTurn (turn, now) {
    const { input } = turn

    // The VAD speech onset when we have it. The first buffered frame only approximates the onset,
    // for a client that appends audio solely while the user talks (client-side turn detection).
    const userStart = input.speechStartTime ?? input.audio.startTime
    const inputFormat = segmentFormat(input.audio, this.#inputAudioMime, this.#inputAudioRate)
    const outputFormat = segmentFormat(turn.audio, this.#outputAudioMime, this.#outputAudioRate)
    const inputDurationMs = segmentDurationMs(
      input.audio.totalDecodedBytes, inputFormat.mimeType, inputFormat.sampleRate
    )
    const userEnd = input.speechEndTime ??
      (userStart !== undefined && inputDurationMs !== undefined ? userStart + inputDurationMs : undefined)

    const agentStart = turn.audio.startTime
    const playbackMs = segmentDurationMs(
      turn.audio.totalDecodedBytes, outputFormat.mimeType, outputFormat.sampleRate
    )
    const agentEnd = agentStart === undefined
      ? undefined
      : (playbackMs === undefined ? (turn.responseDoneTime ?? now) : agentStart + playbackMs)

    // The llm span measures model work: it opens at the end of user speech, not when the human
    // started talking, and closes when generation completes.
    const llmStartTime = input.speechEndTime ?? input.audio.startTime ?? turn.createdTime
    const llmFinishTime = Math.max(turn.responseDoneTime ?? now, llmStartTime)

    const rootStartTime = userStart ?? input.speechEndTime ?? turn.createdTime
    // Unlike dd-trace-py, clamp the root to its children's actual ends so it always contains them: a
    // turn finalized without `response.done` would otherwise finish before its own llm span.
    const rootFinishTime = Math.max(rootStartTime, llmFinishTime, agentEnd ?? 0, userEnd ?? 0)

    return {
      sessionId: this.#sessionId,
      model: turn.model,
      basePath: this.#basePath,
      metadata: { ...this.#sessionConfig },
      usage: turn.usage,
      failed: turn.status === 'failed',
      error: turn.error,
      runInContext: turn.runInContext,
      root: { startTime: rootStartTime, finishTime: rootFinishTime },
      llm: { startTime: llmStartTime, finishTime: llmFinishTime },
      userSpeech: userStart === undefined || userEnd === undefined
        ? undefined
        : {
            startTime: userStart,
            finishTime: Math.max(userStart, userEnd),
            transcript: input.transcript || input.text,
          },
      agentSpeech: agentStart === undefined || agentEnd === undefined
        ? undefined
        : {
            startTime: agentStart,
            finishTime: Math.max(agentStart, agentEnd),
            transcript: turn.transcript.value || turn.text.value,
          },
      input: {
        text: input.text,
        transcript: input.transcript,
        audio: input.audio.toBuffer(),
        audioPresent: input.audio.present,
        mimeType: inputFormat.mimeType,
        sampleRate: inputFormat.sampleRate,
        toolResults: input.toolResults,
      },
      output: {
        text: turn.text.value,
        transcript: turn.transcript.value,
        audio: turn.audio.toBuffer(),
        audioPresent: turn.audio.present,
        mimeType: outputFormat.mimeType,
        sampleRate: outputFormat.sampleRate,
        toolCalls: turn.toolCalls,
        toolResults: turn.toolResults,
      },
    }
  }

  // -- config extraction ----------------------------------------------------

  /**
   * @param {Record<string, unknown>} session
   */
  #updateSessionConfig (session) {
    if (session == null) return

    if (typeof session.model === 'string' && session.model) this.#model = session.model
    if (session.instructions != null) this.#sessionConfig.instructions = String(session.instructions)

    const modalities = session.output_modalities ?? session.modalities
    if (modalities) this.#sessionConfig.output_modalities = [...modalities]

    const { audio } = session
    let inputFormat = audio?.input?.format
    let outputFormat = audio?.output?.format
    let voice = audio?.output?.voice

    // A `session.update` carrying the transcription field explicitly set to `null` turns
    // transcription off, so track whether the field is *present* rather than whether it is set.
    // Latching the flag on would leave every later turn deferred in `#awaiting` for a transcript
    // that is never coming; ignoring absence is equally required, since a partial update that says
    // nothing about transcription must not disable it.
    if (audio?.input != null && Object.hasOwn(audio.input, 'transcription')) {
      this.#inputTranscriptionEnabled = audio.input.transcription != null
    } else if (Object.hasOwn(session, 'input_audio_transcription')) {
      // Legacy flat field (older SDKs).
      this.#inputTranscriptionEnabled = session.input_audio_transcription != null
    }

    inputFormat ??= session.input_audio_format
    outputFormat ??= session.output_audio_format
    voice ??= session.voice

    if (inputFormat != null) {
      this.#inputAudioMime = realtimeAudioFormatToMime(inputFormat)
      this.#sessionConfig.input_audio_format = this.#inputAudioMime
      const rate = toFiniteNumber(inputFormat.rate)
      if (rate) this.#inputAudioRate = rate
    }
    if (outputFormat != null) {
      this.#outputAudioMime = realtimeAudioFormatToMime(outputFormat)
      this.#sessionConfig.output_audio_format = this.#outputAudioMime
      const rate = toFiniteNumber(outputFormat.rate)
      if (rate) this.#outputAudioRate = rate
    }
    if (voice != null) this.#sessionConfig.voice = String(voice)
  }

  /**
   * @param {Record<string, unknown>} item
   * @param {number} now
   */
  #absorbInputItem (item, now) {
    if (item == null) return

    // A tool result the app feeds back becomes a tool result on the next turn's input.
    if (item.type === 'function_call_output') {
      const toolId = String(item.call_id ?? '')
      /** @type {ToolResult} */
      const result = {
        toolId,
        result: item.output == null ? '' : String(item.output),
        type: 'function_call_output',
      }
      // Label the result with the function name carried by the originating call.
      const name = this.#toolCallNames.get(toolId)
      if (name) {
        result.name = name
        this.#toolCallNames.delete(toolId)
      }
      this.#pendingInput.toolResults.push(result)
      return
    }

    // Only user items contribute to the input turn; skip assistant and system items.
    if (item.role != null && item.role !== 'user') return

    const { content } = item
    if (!content) return

    for (const part of content) {
      switch (part?.type) {
        case 'input_text':
        case 'text':
          this.#pendingInput.text += part.text ?? ''
          break
        case 'input_audio':
        case 'audio':
          if (part.audio) {
            this.#pendingInput.audio.append(part.audio, now, this.#inputAudioMime, this.#inputAudioRate)
          }
          if (part.transcript) this.#pendingInput.transcript += part.transcript
      }
    }
  }
}

module.exports = RealtimeSession
