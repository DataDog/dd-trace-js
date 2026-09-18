'use strict'

const log = require('../../../log')

/** @typedef {{ concat?: (other: string | StreamChunk) => StreamChunk, content?: unknown }} StreamChunk */
/** @typedef {{ toChatMessages: () => unknown[] }} PromptValueLike */

/**
 * Joins the chunks yielded by a LangChain `_streamIterator` into a single value.
 * Message/generation chunks expose `concat`, strings are concatenated, anything else keeps the last chunk
 * (e.g. JSON output parsers already yield the accumulated object).
 *
 * @param {Array<string | StreamChunk>} chunks
 * @returns {string | StreamChunk | undefined}
 */
function joinStreamChunks (chunks) {
  const [first] = chunks
  if (typeof first === 'string') {
    let joined = ''
    for (const chunk of chunks) {
      if (typeof chunk !== 'string') return chunks.at(-1)
      joined += chunk
    }
    return joined
  }

  const concat = first?.concat
  if (typeof concat === 'function' && !Array.isArray(first)) {
    try {
      let joined = first
      for (let i = 1; i < chunks.length; i++) {
        joined = concat.call(joined, chunks[i])
      }
      return joined
    } catch (e) {
      log.debug('Failed to concatenate LangChain stream chunks', e)
    }
  }

  return chunks.at(-1)
}

/**
 * Normalizes a `BaseLanguageModelInput` (string, PromptValue or message list) to the `messages[][]`
 * shape accepted by the chat model handler.
 *
 * @param {string | unknown[] | PromptValueLike | null | undefined} input
 * @returns {unknown[][]}
 */
function streamInputToChatMessages (input) {
  if (input == null) return [[]]
  if (typeof input === 'string') return [[input]]
  if (Array.isArray(input)) return [input]
  if (typeof input.toChatMessages === 'function') return [input.toChatMessages()]
  return [[input]]
}

/**
 * Normalizes a `BaseLanguageModelInput` to the prompt string used by the LLM handler.
 *
 * @param {string | object | null | undefined} input
 * @returns {string}
 */
function streamInputToPrompt (input) {
  if (input == null) return ''
  if (typeof input === 'string') return input
  if (typeof input?.toString === 'function' && input.toString !== Object.prototype.toString) return input.toString()
  return JSON.stringify(input)
}

module.exports = {
  joinStreamChunks,
  streamInputToChatMessages,
  streamInputToPrompt,
}
