'use strict'

const AudioAccumulator = require('./audio-accumulator')

/**
 * @typedef {{ name?: string, arguments?: unknown, toolId?: string, type?: string }} ToolCall
 * @typedef {{ name?: string, result?: string, toolId?: string, type?: string }} ToolResult
 */

/**
 * One response's text or transcript, accumulated across the output items it arrives in.
 *
 * Deltas stream per output item, and each item ends with a `.done` carrying that item's
 * authoritative final value. A single response can hold several output items — a server-side MCP
 * call sits between a preamble message and the answer — so a `.done` replaces only the span its own
 * item contributed rather than the whole response, which would drop every item before it.
 *
 * Events that carry no item id are treated as one continuous item, which is how a response with a
 * single output item behaves anyway.
 */
class ItemText {
  /** @type {string} */
  value = ''

  /** @type {string | undefined} */
  #itemId = undefined

  /** Offset into `value` at which the current item's span begins. */
  #itemStart = 0

  /**
   * @param {unknown} itemId
   * @param {string} delta
   */
  appendDelta (itemId, delta) {
    this.#openItem(itemId)
    this.value += delta
  }

  /**
   * Replace the current item's span with the final value the server reported for it.
   *
   * @param {unknown} itemId
   * @param {string} final
   */
  complete (itemId, final) {
    this.#openItem(itemId)
    this.value = this.value.slice(0, this.#itemStart) + final
  }

  /**
   * Begin a new item's span, leaving everything earlier items contributed in place.
   *
   * @param {unknown} itemId
   */
  #openItem (itemId) {
    const item = itemId == null ? undefined : String(itemId)
    if (item === this.#itemId) return

    this.#itemId = item
    this.#itemStart = this.value.length
  }
}

/** Accumulated user input — audio plus transcript or text — for a single turn. */
class InputTurn {
  /**
   * @param {boolean} [retainAudio] - False when nothing consumes the bytes, so only their count is
   *   kept. See `AudioAccumulator`.
   */
  constructor (retainAudio = true) {
    this.audio = new AudioAccumulator(retainAudio)
  }

  text = ''

  transcript = ''

  /** @type {string | undefined} */
  itemId = undefined

  /**
   * Wall clock (epoch ms) when the user actually started speaking, from the VAD speech-onset event.
   * This is the start of the user-speech window; the first buffered frame is not, because a
   * server-VAD client streams the microphone continuously.
   *
   * @type {number | undefined}
   */
  speechStartTime = undefined

  /**
   * Wall clock (epoch ms) when the input audio was committed (roughly the end of user speech). Lets
   * response latency be measured from real speech-end rather than the padded buffer end.
   *
   * @type {number | undefined}
   */
  speechEndTime = undefined

  /**
   * Offset (ms) on the session's input-audio-buffer timeline of the first frame buffered for this
   * turn, so a VAD offset can be converted into a byte offset into `audio`.
   *
   * @type {number | undefined}
   */
  audioBaseMs = undefined

  /**
   * Tool results the app fed back (`function_call_output`) before the next response.
   *
   * @type {ToolResult[]}
   */
  toolResults = []

  /**
   * The input audio buffer was cleared: drop the buffered audio and the speech onset derived from
   * it, so neither can be attributed to the next response. A commit that already happened is left
   * alone — a client that clears the buffer after committing has still ended that speech.
   */
  discardAudio () {
    this.audio.clear()
    this.speechStartTime = undefined
    this.audioBaseMs = undefined
  }
}

/** Accumulated assistant output for a single `response.*` lifecycle. */
class ResponseTurn {
  /**
   * @param {InputTurn} input
   * @param {number} createdTime - Epoch ms at which `response.created` arrived. The fallback start
   *   for the turn root and llm spans when the turn produced no user speech to back-date to.
   * @param {boolean} [retainAudio] - False when nothing consumes the bytes, so only their count is
   *   kept. See `AudioAccumulator`.
   */
  constructor (input, createdTime, retainAudio = true) {
    this.input = input
    this.createdTime = createdTime
    this.audio = new AudioAccumulator(retainAudio)
  }

  transcript = new ItemText()

  text = new ItemText()

  /** @type {{ input_tokens?: number, output_tokens?: number, total_tokens?: number } | undefined} */
  usage = undefined

  /** @type {string | undefined} */
  model = undefined

  /** @type {string | undefined} */
  status = undefined

  /**
   * The provider's own account of a failure, from `response.done`'s `status_details.error`. Carried
   * separately from `status` because `failed` alone leaves a span with no way to say what went wrong.
   *
   * @type {{ type?: string, code?: string, message?: string } | undefined}
   */
  error = undefined

  /**
   * Wall clock (epoch ms) when `response.done` arrived. The llm span ends here — generation
   * complete — not when the agent finishes speaking.
   *
   * @type {number | undefined}
   */
  responseDoneTime = undefined

  /**
   * Byte offset into `audio` at which each output item's audio begins, so a truncation — which is
   * reported per item — maps onto this turn's segment.
   *
   * @type {Map<string, number>}
   */
  audioItemStarts = new Map()

  /**
   * Wall clock (epoch ms) at which the agent's audio would finish playing. Set while the turn is
   * held open waiting for playback to end.
   *
   * @type {number | undefined}
   */
  playbackEndTime = undefined

  /**
   * Runs a callback inside the async context that was active when this turn started, so the span
   * tree replayed at finalize nests under the caller's own APM and LLM Observability context.
   * Composed by the tracing and LLM Observability plugins off the capture-context channel; absent
   * when neither is subscribed.
   *
   * @type {((fn: () => void) => void) | undefined}
   */
  runInContext = undefined

  /**
   * Function and MCP calls the model made this turn.
   *
   * @type {ToolCall[]}
   */
  toolCalls = []

  /**
   * Inline MCP results for the calls above.
   *
   * @type {ToolResult[]}
   */
  toolResults = []
}

module.exports = { InputTurn, ItemText, ResponseTurn }
