'use strict'

/**
 * Combines legacy OpenAI streamed chunks into a single object.
 * These legacy chunks are returned as buffers instead of individual objects.
 * @param {readonly Uint8Array[]} chunks
 * @returns {Array<Record<string, any>>}
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
 * @param {Array<Record<string, any>>} chunks
 * @param {number} n
 * @param {function(Record<string, any>, Record<string, any>): void} onChoice
 * @returns {Record<string, any>}
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
 * @param {Array<Record<string, any>>} chunks
 * @param {number} n the number of choices to expect in the response
 * @returns {Record<string, any>}
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
 * @param {Array<Record<string, any>>} chunks
 * @param {number} n the number of choices to expect in the response
 * @returns {Record<string, any>}
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

module.exports = {
  convertBuffersToObjects,
  constructCompletionResponseFromStreamedChunks,
  constructChatCompletionResponseFromStreamedChunks
}
