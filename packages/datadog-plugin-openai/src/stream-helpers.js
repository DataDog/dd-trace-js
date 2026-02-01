'use strict'

/**
 * @typedef {Record<string, unknown>} JsonObject
 *
 * @typedef {{ function: { arguments: string } }} ToolCall
 * @typedef {{ content?: string, tool_calls?: ToolCall[] }} ChatDelta
 *
 * @typedef {{
 *   index: number,
 *   finish_reason?: string | null,
 *   text?: string,
 *   delta?: ChatDelta
 * }} StreamChoice
 *
 * @typedef {JsonObject & { choices: StreamChoice[], usage?: unknown }} StreamChunk
 * @typedef {JsonObject & { choices: Array<StreamChoice | undefined>, usage?: unknown }} StreamResponseBody
 *
 * @typedef {JsonObject & { status?: string }} ResponsesApiResponse
 * @typedef {JsonObject & { response?: ResponsesApiResponse }} ResponsesApiChunk
 */

/**
 * Combines legacy OpenAI streamed chunks into a single object.
 * These legacy chunks are returned as buffers instead of individual objects.
 * @param {readonly Uint8Array[]} chunks
 * @returns {JsonObject[]}
 */
function convertBuffersToObjects (chunks) {
  return Buffer
    .concat(chunks) // combine the buffers
    .toString() // stringify
    .split(/(?=data:)/) // split on "data:"
    .map(chunk => chunk.replaceAll('\n', '').slice(6)) // remove newlines and 'data: ' from the front
    .slice(0, -1) // remove the last [DONE] message
    .map(JSON.parse) // parse all of the returned objects
}

/**
 * Common function for combining chunks with n choices into a single response body.
 * The shared logic will add a new choice index entry if it doesn't exist, and otherwise
 * hand off to a onChoice handler to add that choice to the previously stored choice.
 *
 * @param {StreamChunk[]} chunks
 * @param {number} n
 * @param {(newChoice: StreamChoice, existingChoice: StreamChoice) => void} onChoice
 * @returns {StreamResponseBody}
 */
function constructResponseFromStreamedChunks (chunks, n, onChoice) {
  const body = { ...chunks[0], choices: Array.from({ length: n }) }

  for (const chunk of chunks) {
    body.usage = chunk.usage
    for (const choice of chunk.choices) {
      const choiceIdx = choice.index
      const oldChoice = body.choices.find(choice => choice?.index === choiceIdx)

      if (!oldChoice) {
        body.choices[choiceIdx] = choice
        continue
      }

      if (!oldChoice.finish_reason) {
        oldChoice.finish_reason = choice.finish_reason
      }

      onChoice(choice, oldChoice)
    }
  }

  return body
}

/**
 * Constructs the entire response from a stream of OpenAI completion chunks,
 * mainly combining the text choices of each chunk into a single string per choice.
 * @param {StreamChunk[]} chunks
 * @param {number} n the number of choices to expect in the response
 * @returns {StreamResponseBody}
 */
function constructCompletionResponseFromStreamedChunks (chunks, n) {
  return constructResponseFromStreamedChunks(chunks, n, (choice, oldChoice) => {
    const text = choice.text
    if (text) {
      if (oldChoice.text) {
        oldChoice.text += text
      } else {
        oldChoice.text = text
      }
    }
  })
}

/**
 * Constructs the entire response from a stream of OpenAI chat completion chunks,
 * mainly combining the text choices of each chunk into a single string per choice.
 * @param {StreamChunk[]} chunks
 * @param {number} n the number of choices to expect in the response
 * @returns {StreamResponseBody}
 */
function constructChatCompletionResponseFromStreamedChunks (chunks, n) {
  return constructResponseFromStreamedChunks(chunks, n, (choice, oldChoice) => {
    const delta = choice.delta
    if (!delta) return

    const content = delta.content
    if (content) {
      if (oldChoice.delta.content) {
        oldChoice.delta.content += content
      } else {
        oldChoice.delta.content = content
      }
    }

    const tools = delta.tool_calls
    if (!tools) return

    oldChoice.delta.tool_calls = tools.map((newTool, toolIdx) => {
      const oldTool = oldChoice.delta.tool_calls?.[toolIdx]
      if (oldTool) {
        oldTool.function.arguments += newTool.function.arguments
        return oldTool
      }

      return newTool
    })
  })
}

/**
 * Constructs the entire response from a stream of OpenAI responses chunks.
 * The responses API uses event-based streaming with delta chunks.
 * @param {ResponsesApiChunk[]} chunks
 * @returns {ResponsesApiResponse|undefined}
 */
function constructResponseResponseFromStreamedChunks (chunks) {
  // The responses API streams events with different types:
  // - response.output_text.delta: incremental text deltas
  // - response.output_text.done: complete text for a content part
  // - response.output_item.done: complete output item with role
  // - response.done/response.incomplete/response.completed: final response with output array and usage

  // Find the last chunk with a complete response object (status: done, incomplete, or completed)
  const responseStatusSet = new Set(['done', 'incomplete', 'completed'])

  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i]
    if (chunk.response && responseStatusSet.has(chunk.response.status)) {
      return chunk.response
    }
  }
}

module.exports = {
  convertBuffersToObjects,
  constructCompletionResponseFromStreamedChunks,
  constructChatCompletionResponseFromStreamedChunks,
  constructResponseResponseFromStreamedChunks,
}
