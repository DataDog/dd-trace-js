'use strict'

const dc = require('dc-polyfill')
const shimmer = require('../../../datadog-shimmer')
const { convertOpenAIResponseItemsToMessages } = require('./ai-messages')

// TODO: this channel name is incorrect, instrumentations publish with THEIR name, not with their subscribers names.
const aiguardChannel = dc.channel('dd-trace:ai:aiguard')

const AIGUARD_CONVERSATIONAL_RESOURCES = new Set(['chat.completions', 'responses'])

/**
 * Publishes already-converted AI-style messages to the AI Guard evaluation channel.
 *
 * @param {Array<object>} messages - AI-style messages to evaluate.
 * @returns {Promise<void>}
 */
function publishEvaluation (messages) {
  return new Promise((resolve, reject) => {
    aiguardChannel.publish({ messages, integration: 'openai', resolve, reject })
  })
}

/**
 * Extracts OpenAI input messages from a `chat.completions.create` call.
 *
 * @param {object} callArgs - First argument passed to the wrapped method
 * @returns {Array<object>|undefined}
 */
function getChatCompletionsInputMessages (callArgs) {
  return callArgs?.messages?.length ? callArgs.messages : undefined
}

/**
 * Extracts OpenAI input messages from a `responses.create` call. The `instructions`
 * field is treated as a system prompt — it directly steers model behavior and the
 * LLMObs OpenAI plugin already surfaces it as one — so AI Guard must screen it too.
 *
 * @param {object} callArgs - First argument passed to the wrapped method
 * @returns {Array<object>|undefined}
 */
function getResponsesInputMessages (callArgs) {
  const input = convertOpenAIResponseItemsToMessages(callArgs?.input, 'user')
  if (typeof callArgs?.instructions === 'string' && callArgs.instructions.length) {
    const messages = [{ role: 'system', content: callArgs.instructions }]
    for (const message of input) messages.push(message)
    return messages
  }
  return input.length ? input : undefined
}

/**
 * Extracts OpenAI input messages from a method call's first argument.
 *
 * @param {string} baseResource - Either `'chat.completions'` or `'responses'`
 * @param {object} callArgs - First argument passed to the wrapped OpenAI method
 * @returns {Array<object>|undefined}
 */
function getInputMessages (baseResource, callArgs) {
  if (baseResource === 'chat.completions') return getChatCompletionsInputMessages(callArgs)
  if (baseResource === 'responses') return getResponsesInputMessages(callArgs)
}

/**
 * Extracts OpenAI output messages from a `chat.completions.create` parsed body.
 * Includes any choice whose message carries content (including empty string),
 * `tool_calls`, a `refusal` field, or the deprecated `function_call` field. GPT-4o
 * emits `{content: null, refusal: "..."}` on policy refusals, and pre-tool-call
 * SDK paths still produce `function_call`-only output — AI Guard must still see them.
 *
 * @param {object} body - Parsed response body
 * @returns {Array<object>}
 */
function getChatCompletionsOutputMessages (body) {
  const messages = []
  const choices = Array.isArray(body?.choices) ? body.choices : []
  for (const choice of choices) {
    const message = choice?.message
    if (
      message?.content != null ||
      message?.tool_calls?.length ||
      message?.refusal != null ||
      message?.function_call != null
    ) {
      messages.push(message)
    }
  }
  return messages
}

/**
 * Extracts OpenAI output messages from a `responses.create` parsed body.
 *
 * @param {object} body - Parsed response body
 * @returns {Array<object>}
 */
function getResponsesOutputMessages (body) {
  return convertOpenAIResponseItemsToMessages(body?.output, 'assistant')
}

/**
 * Extracts OpenAI output messages from parsed response bodies.
 *
 * @param {string} baseResource - Either `'chat.completions'` or `'responses'`
 * @param {object} body - Parsed response body
 * @returns {Array<object>}
 */
function getOutputMessages (baseResource, body) {
  if (baseResource === 'chat.completions') return getChatCompletionsOutputMessages(body)
  if (baseResource === 'responses') return getResponsesOutputMessages(body)
  return []
}

/**
 * Publishes AI Guard After Model evaluation for extracted OpenAI output messages.
 *
 * @param {string} baseResource - Either `'chat.completions'` or `'responses'`
 * @param {Array<object>} inputMessages - Already-converted AI Guard style input messages
 * @param {Array<object>} outputMessages - Already-converted AI Guard style output messages
 * @returns {Promise<void|Array<void>>}
 */
function publishOutputEvaluation (baseResource, inputMessages, outputMessages) {
  if (!outputMessages.length) return Promise.resolve()

  if (baseResource === 'chat.completions') {
    // Chat completions may return multiple choices when `n > 1`. Screen every choice
    // concurrently so any unsafe assistant output rejects `.parse()`, regardless of
    // which choice the caller ends up using.
    const evals = []
    for (const message of outputMessages) {
      evals.push(publishEvaluation([...inputMessages, message]))
    }
    return Promise.all(evals)
  }

  return publishEvaluation([...inputMessages, ...outputMessages])
}

/**
 * Reports whether the AI Guard channel has subscribers. The OpenAI instrumentation
 * uses this to decide whether to take the AI Guard path at all.
 *
 * @returns {boolean}
 */
function hasSubscribers () {
  return aiguardChannel.hasSubscribers
}

/**
 * Builds a guard handle when AI Guard is enabled and applicable to this call. The
 * handle exposes a lazy `getInputEval` so Before Model evaluation only kicks off
 * once the caller consumes the APIPromise. Returns null when AI Guard does not apply
 * (no subscribers, non-conversational resource, streaming, or no input messages).
 *
 * @param {string} baseResource - Either `'chat.completions'` or `'responses'`
 * @param {object} callArgs - First argument passed to the wrapped OpenAI method
 * @param {boolean} stream - Whether the caller asked for a streamed response
 * @returns {{baseResource: string, inputMessages: Array<object>, getInputEval: () => Promise<void>}|null}
 */
function createGuard (baseResource, callArgs, stream) {
  // Streaming AI Guard support lands in a follow-up PR. For now, provider-level AI
  // Guard only evaluates non-streaming responses.
  if (stream || !AIGUARD_CONVERSATIONAL_RESOURCES.has(baseResource) || !aiguardChannel.hasSubscribers) {
    return null
  }
  const inputMessages = getInputMessages(baseResource, callArgs)
  if (!inputMessages) return null

  let inputEvalPromise
  const getInputEval = () => (inputEvalPromise ??= publishEvaluation(inputMessages))
  return { baseResource, inputMessages, getInputEval }
}

/**
 * Wraps `apiProm.asResponse` so callers that consume the raw `Response` object still
 * receive the Before Model verdict. After Model evaluation is not performed on this
 * path because the response body has not been parsed.
 *
 * @param {object} apiProm - APIPromise returned from the OpenAI SDK method
 * @param {{getInputEval: () => Promise<void>}} guard
 */
function wrapAsResponse (apiProm, guard) {
  if (typeof apiProm.asResponse !== 'function') return
  shimmer.wrap(apiProm, 'asResponse', origAsResponse => function () {
    const responsePromise = origAsResponse.apply(this, arguments)
    return Promise.all([guard.getInputEval(), responsePromise]).then(([, response]) => response)
  })
}

/**
 * Gates the parsed-body promise on Before Model evaluation. Resolves to the SDK's
 * result only once the Before Model verdict is in.
 *
 * @param {Promise<unknown>} parsedPromise
 * @param {{getInputEval: () => Promise<void>}} guard
 * @returns {Promise<unknown>}
 */
function gateParse (parsedPromise, guard) {
  return Promise.all([guard.getInputEval(), parsedPromise]).then(([, result]) => result)
}

/**
 * Runs After Model evaluation against the response body.
 *
 * @param {{baseResource: string, inputMessages: Array<object>}} guard
 * @param {object} body - Parsed OpenAI response body
 * @returns {Promise<void|Array<void>>}
 */
function evaluateOutput (guard, body) {
  const outputMessages = getOutputMessages(guard.baseResource, body)
  return publishOutputEvaluation(guard.baseResource, guard.inputMessages, outputMessages)
}

module.exports = {
  hasSubscribers,
  createGuard,
  wrapAsResponse,
  gateParse,
  evaluateOutput,
}
