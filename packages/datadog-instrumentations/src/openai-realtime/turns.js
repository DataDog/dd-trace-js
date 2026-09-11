'use strict'

const AudioAccumulator = require('./audio-accumulator')

/**
 * @typedef {{ name?: string, arguments?: unknown, toolId?: string, type?: string }} ToolCall
 * @typedef {{ name?: string, result?: string, toolId?: string, type?: string }} ToolResult
 */

/** Accumulated user input — audio plus transcript or text — for a single turn. */
class InputTurn {
  audio = new AudioAccumulator()

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
   *
   * @returns {void}
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
   */
  constructor (input, createdTime) {
    this.input = input
    this.createdTime = createdTime
  }

  audio = new AudioAccumulator()

  transcript = ''

  text = ''

  /** @type {{ input_tokens?: number, output_tokens?: number, total_tokens?: number } | undefined} */
  usage = undefined

  /** @type {string | undefined} */
  model = undefined

  /** @type {string | undefined} */
  status = undefined

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

module.exports = { InputTurn, ResponseTurn }
