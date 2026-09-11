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

  #pendingInput = new InputTurn()

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
   */
  constructor ({ emitTurn, captureContext, model, basePath = '' }) {
    this.#emitTurn = emitTurn
    this.#captureContext = captureContext
    this.#model = model
    this.#basePath = basePath
  }

  // -- event entry points ---------------------------------------------------

  /**
   * @param {Record<string, unknown>} event
   * @param {number} now - Epoch ms at which the event was observed.
   * @returns {void}
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
      }
    } catch (error) {
      log.debug('Error handling OpenAI realtime client event: %s', error?.message)
    }
  }

  /**
   * @param {Record<string, unknown>} event
   * @param {number} now - Epoch ms at which the event was observed.
   * @returns {void}
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
          // No transcription is coming for this item, so finalize any turn waiting on it rather than
          // let its span hang until the next turn or close.
          this.#finalizeAwaitingFor(event.item_id, now)
          return
        case 'response.created':
          this.#startResponse(event.response?.id ?? event.response_id, now)
          return
        case 'response.done':
          this.#finishResponse(event.response?.id ?? event.response_id, event.response, now)
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
   * @returns {void}
   */
  finishSession (now) {
    if (this.#closed) return
    this.#closed = true

    try {
      this.#flushAwaiting(now)
      this.#flushPlaying(now, true)

      // In-flight turns that never saw `response.done` (closed mid-turn). Whatever partial data we
      // have is submitted.
      for (const turn of this.#responses.values()) {
        this.#applyCachedTranscript(turn)
        this.#finalizeTurn(turn, now, true)
      }

      this.#responses.clear()
      this.#inputTranscripts.clear()
      this.#toolCallNames.clear()
    } catch (error) {
      log.debug('Error finalizing OpenAI realtime session: %s', error?.message)
    }
  }

  // -- response deltas ------------------------------------------------------

  /**
   * @param {Record<string, unknown>} event
   * @param {string} eventType
   * @param {number} now
   * @returns {void}
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
        turn.transcript += event.delta ?? ''
        return
      case 'response.audio_transcript.done':
        turn.transcript = event.transcript ?? turn.transcript
        return
      case 'response.text.delta':
        turn.text += event.delta ?? ''
        return
      case 'response.text.done':
        turn.text = event.text ?? turn.text
    }
  }

  // -- input audio and the speech window ------------------------------------

  /**
   * Buffer a client audio append for the pending turn and advance the input-buffer clock.
   *
   * @param {string} base64
   * @param {number} now
   * @returns {void}
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
   * @returns {void}
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
   * @returns {void}
   */
  #onSpeechStarted (audioStartMs, now) {
    const pending = this.#pendingInput
    if (pending.speechStartTime !== undefined) return

    const onset = this.#bufferOffsetToWallTime(audioStartMs, now)
    pending.speechStartTime = onset

    const hadAudio = pending.audio.startTime !== undefined
    pending.audio.trimLeading(this.#preOnsetBytes(audioStartMs))
    // Re-anchor the segment on the onset: whatever survived the trim starts there.
    if (hadAudio) pending.audio.startTime = onset
  }

  /**
   * Byte count of the audio buffered for this turn ahead of the speech onset.
   *
   * @param {unknown} audioStartMs
   * @returns {number}
   */
  #preOnsetBytes (audioStartMs) {
    const baseMs = this.#pendingInput.audioBaseMs
    const onsetMs = toFiniteNumber(audioStartMs)
    const rate = bytesPerSecond(this.#inputAudioMime, this.#inputAudioRate)
    if (baseMs === undefined || onsetMs === undefined || !rate) return 0

    return Math.max(0, Math.trunc((onsetMs - baseMs) / 1000 * rate))
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
   * @returns {number}
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
   * @returns {void}
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
   * @param {Turn} turn
   * @param {number} now
   * @returns {boolean} Whether the turn was parked.
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
   * @returns {void}
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
   * @param {unknown} responseId
   * @param {number} now
   * @returns {void}
   */
  #startResponse (responseId, now) {
    if (responseId == null) return

    // A new turn starting means a prior turn's input transcription is almost certainly not coming
    // anymore, and that any held playback is over (or was cut off without a truncation reaching us),
    // so flush both rather than let a turn hang.
    this.#flushAwaiting(now)
    this.#flushPlaying(now, true)

    const turn = new ResponseTurn(this.#pendingInput, now)
    this.#pendingInput = new InputTurn()
    turn.model = this.#model

    this.#captureContext(turn)
    this.#responses.set(String(responseId), turn)
  }

  /**
   * @param {unknown} responseId
   * @param {Record<string, unknown>} response
   * @param {number} now
   * @returns {void}
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

    // Hold the turn open for a late input transcription ONLY when transcription is actually enabled:
    // otherwise no transcript is ever coming, and waiting would needlessly delay every turn until
    // the next one, and the last turn until close.
    if (!turn.input.transcript && turn.input.itemId !== undefined && this.#inputTranscriptionEnabled) {
      this.#awaiting.push(turn)
      return
    }

    this.#finalizeTurn(turn, now)
  }

  /**
   * @param {unknown} itemId
   * @param {unknown} transcript
   * @param {number} now
   * @returns {void}
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
   * @returns {void}
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
   * @returns {void}
   */
  #flushAwaiting (now) {
    if (this.#awaiting.length === 0) return

    const awaiting = this.#awaiting
    this.#awaiting = []
    for (const turn of awaiting) this.#finalizeTurn(turn, now, true)
  }

  /**
   * @param {Turn} turn
   * @returns {void}
   */
  #applyCachedTranscript (turn) {
    if (turn.input.transcript || turn.input.itemId === undefined) return
    turn.input.transcript = this.#inputTranscripts.get(turn.input.itemId) ?? ''
  }

  /**
   * @param {Turn} turn
   * @param {number} now
   * @param {boolean} [force] - Skip parking, for the paths that must not wait (close, next turn).
   * @returns {void}
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
            transcript: turn.transcript || turn.text,
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
        text: turn.text,
        transcript: turn.transcript,
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
   * @returns {void}
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

    if (audio?.input?.transcription != null) this.#inputTranscriptionEnabled = true
    // Legacy flat fields (older SDKs).
    if (session.input_audio_transcription != null) this.#inputTranscriptionEnabled = true
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
   * @returns {void}
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
