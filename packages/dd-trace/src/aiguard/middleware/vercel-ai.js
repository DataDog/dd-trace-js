'use strict'

const log = require('../../log')
const { convertToAIGuardFormat, convertToolCallPart } = require('./convert')

class AIGuardMiddlewareAbortError extends Error {
  /**
   * @param {'Prompt' | 'Tool call'} kind - The type of evaluation that was blocked
   */
  constructor (kind) {
    super(`${kind} blocked by AI Guard security policy`)
    this.name = 'AIGuardMiddlewareAbortError'
    this.code = 'AI_GUARD_MIDDLEWARE_ABORT'
    this.kind = kind
  }
}

class AIGuardMiddlewareClientError extends Error {
  constructor () {
    super('AI Guard evaluation failed')
    this.name = 'AIGuardMiddlewareClientError'
    this.code = 'AI_GUARD_MIDDLEWARE_CLIENT_ERROR'
  }
}

class TripWire extends Error {
  /**
   * @param {string} message
   */
  constructor (message) {
    super(message)
    this.name = 'TripWire'
  }
}

/**
 * @typedef {object} AIGuardMiddlewareOptions
 * @property {object} tracer - The initialized dd-trace tracer instance
 * @property {boolean} [allowOnFailure=true] - Whether to allow when AI Guard evaluation fails
 */

/**
 * @typedef {'Prompt' | 'Tool call'} GuardKind
 */

// NOTE: async/await is required by Vercel AI SDK middleware interface
/** AI Guard middleware for Vercel AI SDK. */
class AIGuardMiddleware {
  /** @type {'v3'} */
  specificationVersion = 'v3'

  /** @type {object} */
  #tracer

  /** @type {boolean} */
  #allowOnFailure

  /**
   * @param {AIGuardMiddlewareOptions} options
   * @throws {TypeError}
   */
  constructor (options) {
    const { tracer, allowOnFailure = true } = options || {}

    if (!tracer) {
      throw new TypeError('AIGuardMiddleware: tracer is required')
    }

    this.#tracer = tracer
    this.#allowOnFailure = allowOnFailure

    this.wrapGenerate = this.wrapGenerate.bind(this)
    this.wrapStream = this.wrapStream.bind(this)
  }

  /**
   * @param {Array<object>} messages
   * @param {GuardKind} kind
   * @returns {Promise<void>}
   */
  async #evaluate (messages, kind) {
    const aiguard = this.#tracer.aiguard

    if (!aiguard) {
      log.warn('[AI Guard Middleware] AI Guard SDK not available')
      return
    }

    try {
      await aiguard.evaluate(messages, { block: true })
    } catch (error) {
      if (error.name === 'AIGuardAbortError') {
        throw new AIGuardMiddlewareAbortError(kind)
      }

      log.error('[AI Guard Middleware] Evaluation failed: %s', error.message)
      if (this.#allowOnFailure) {
        return
      }
      throw new AIGuardMiddlewareClientError()
    }
  }

  /**
   * @param {Array<object>} prompt
   * @returns {Promise<void>}
   */
  async #evaluatePrompt (prompt) {
    const messages = convertToAIGuardFormat(prompt)
    await this.#evaluate(messages, 'Prompt')
  }

  /**
   * @param {object} toolCall
   * @param {Array<object>} prompt
   * @returns {Promise<void>}
   */
  async #evaluateToolCall (toolCall, prompt) {
    const baseMessages = convertToAIGuardFormat(prompt)
    const toolCallMessage = {
      role: 'assistant',
      content: '',
      tool_calls: [convertToolCallPart(toolCall)]
    }
    const messages = [...baseMessages, toolCallMessage]
    await this.#evaluate(messages, 'Tool call')
  }

  /**
   * @param {Error} error
   * @returns {TripWire}
   */
  #createTripWireForError (error) {
    if (error instanceof AIGuardMiddlewareAbortError) {
      return new TripWire('Tool call blocked by AI Guard security policy')
    }
    if (error instanceof AIGuardMiddlewareClientError) {
      return new TripWire('AI Guard evaluation failed')
    }
    return new TripWire('AI Guard security check failed')
  }

  /**
   * @param {object} args
   * @param {function(): Promise<object>} args.doGenerate
   * @param {object} args.params
   * @param {object} args.model
   * @returns {Promise<object>}
   */
  async wrapGenerate ({ doGenerate, params, model }) {
    await this.#evaluatePrompt(params.prompt)

    const result = await doGenerate()

    if (result.toolCalls && result.toolCalls.length > 0) {
      for (const toolCall of result.toolCalls) {
        // eslint-disable-next-line no-await-in-loop
        await this.#evaluateToolCall(toolCall, params.prompt)
      }
    }

    return result
  }

  /**
   * @param {object} args
   * @param {function(): Promise<object>} args.doStream
   * @param {object} args.params
   * @param {object} args.model
   * @returns {Promise<object>}
   */
  async wrapStream ({ doStream, params, model }) {
    await this.#evaluatePrompt(params.prompt)

    const result = await doStream()

    const self = this
    let stopped = false

    // eslint-disable-next-line n/no-unsupported-features/node-builtins
    const transform = new TransformStream({
      async transform (chunk, controller) {
        if (stopped) {
          return
        }

        if (chunk.type === 'tool-call') {
          try {
            await self.#evaluateToolCall(chunk, params.prompt)
          } catch (error) {
            stopped = true
            controller.enqueue({
              type: 'error',
              error: self.#createTripWireForError(error)
            })
            controller.terminate()
            return
          }
        }

        controller.enqueue(chunk)
      }
    })

    const wrappedStream = result.stream.pipeThrough(transform)

    return {
      ...result,
      stream: wrappedStream
    }
  }
}

module.exports = { AIGuardMiddleware }
