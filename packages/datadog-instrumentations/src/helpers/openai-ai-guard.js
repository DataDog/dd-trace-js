'use strict'

const dc = require('dc-polyfill')
const shimmer = require('../../../datadog-shimmer')
const {
  convertOpenAIResponseItemsToMessages,
  convertOpenAIResponsePromptToMessages,
  normalizeOpenAIChatMessages,
} = require('./ai-messages')

// TODO: this channel name is incorrect, instrumentations publish with THEIR name, not with their subscribers names.
const aiguardChannel = dc.channel('dd-trace:ai:aiguard')

/**
 * @typedef {object} ResourceHandler
 * @property {(callArgs: object) => (Array<object>|undefined)} getInputMessages
 * @property {(body: object) => Array<object>} getOutputMessages
 * @property {(inputMessages: Array<object>, outputMessages: Array<object>, parentSpan?: object)
 *   => Promise<unknown>} publishOutputEvaluation
 */

/**
 * @typedef {object} Guard
 * @property {ResourceHandler} handler
 * @property {Array<object>} inputMessages
 * @property {() => Promise<void>} getInputEval
 * @property {object} [parentSpan] - LLM span (`openai.request`) to nest `ai_guard` spans under.
 *   Set by the instrumentation once the LLM span is active.
 */

/**
 * Publishes already-converted AI-style messages to the AI Guard evaluation channel.
 *
 * @param {Array<object>} messages - AI-style messages to evaluate.
 * @param {object} [parentSpan] - LLM span to use as the `ai_guard` span's parent.
 * @returns {Promise<void>}
 */
function publishEvaluation (messages, parentSpan) {
  return new Promise((resolve, reject) => {
    aiguardChannel.publish({ messages, integration: 'openai', parentSpan, resolve, reject })
  })
}

/**
 * Extracts OpenAI input messages from a `chat.completions.create` call.
 *
 * @param {object} callArgs - First argument passed to the wrapped method
 * @returns {Array<object>|undefined}
 */
function getChatCompletionsInputMessages (callArgs) {
  return normalizeOpenAIChatMessages(callArgs?.messages)
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
  const eligible = []
  const choices = Array.isArray(body?.choices) ? body.choices : []
  for (const choice of choices) {
    const message = choice?.message
    if (
      message?.content != null ||
      message?.tool_calls?.length ||
      message?.refusal != null ||
      message?.function_call != null
    ) {
      eligible.push(message)
    }
  }
  return normalizeOpenAIChatMessages(eligible) ?? []
}

/**
 * Publishes AI Guard After Model evaluation for `chat.completions` output.
 *
 * Chat completions may return multiple choices when `n > 1`. Screen every choice
 * concurrently so any unsafe assistant output rejects `.parse()`, regardless of
 * which choice the caller ends up using.
 *
 * @param {Array<object>} inputMessages
 * @param {Array<object>} outputMessages - One entry per choice
 * @param {object} [parentSpan]
 * @returns {Promise<Array<void>>}
 */
function publishChatCompletionsOutputEvaluation (inputMessages, outputMessages, parentSpan) {
  const evals = []
  for (const message of outputMessages) {
    evals.push(publishEvaluation([...inputMessages, message], parentSpan))
  }
  return Promise.all(evals)
}

/**
 * Extracts OpenAI input messages from a `responses.create` call. The `instructions`
 * field is treated as a developer prompt — it directly steers model behavior and the
 * LLMObs OpenAI plugin already surfaces it as one — so AI Guard must screen it too.
 *
 * AI Guard `/evaluate` accepts a single leading system/developer message; if the
 * caller's `input` already begins with one, prepend the `instructions` text to its
 * content rather than emit a second developer turn.
 *
 * @param {object} callArgs - First argument passed to the wrapped method
 * @returns {Array<object>|undefined}
 */
function getResponsesInputMessages (callArgs) {
  const messages = [
    ...convertOpenAIResponseItemsToMessages(callArgs?.input, 'user'),
    ...convertOpenAIResponsePromptToMessages(callArgs?.prompt),
  ]

  const instructions = typeof callArgs?.instructions === 'string' && callArgs.instructions.length
    ? callArgs.instructions
    : null
  if (!instructions) return messages.length ? messages : undefined

  const first = messages[0]
  if (first && (first.role === 'developer' || first.role === 'system')) {
    const merged = { role: 'developer', content: mergeInstructionsWithContent(instructions, first.content) }
    return [merged, ...messages.slice(1)]
  }
  return [{ role: 'developer', content: instructions }, ...messages]
}

/**
 * Merges Responses API instructions with an existing leading developer/system content value.
 *
 * @param {string} instructions
 * @param {string|Array<object>|undefined} content
 * @returns {string|Array<object>}
 */
function mergeInstructionsWithContent (instructions, content) {
  if (Array.isArray(content)) return [{ type: 'text', text: instructions }, ...content]
  if (typeof content === 'string' && content.length) return `${instructions}\n\n${content}`
  return instructions
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
 * Publishes AI Guard After Model evaluation for `responses` output.
 *
 * The Responses API returns a single conversation turn whose `output` items form one
 * coherent message (reasoning steps + final assistant message + tool calls + ...);
 * they are screened together as a single evaluation.
 *
 * @param {Array<object>} inputMessages
 * @param {Array<object>} outputMessages
 * @param {object} [parentSpan]
 * @returns {Promise<void>}
 */
function publishResponsesOutputEvaluation (inputMessages, outputMessages, parentSpan) {
  return publishEvaluation([...inputMessages, ...outputMessages], parentSpan)
}

/**
 * Per-resource handlers describing how AI Guard reads inputs and screens outputs for
 * each LLM-prompt-accepting OpenAI endpoint. The keys also serve as the set of
 * resources eligible for AI Guard evaluation.
 *
 * @type {Record<string, ResourceHandler>}
 */
const RESOURCE_HANDLERS = {
  'chat.completions': {
    getInputMessages: getChatCompletionsInputMessages,
    getOutputMessages: getChatCompletionsOutputMessages,
    publishOutputEvaluation: publishChatCompletionsOutputEvaluation,
  },
  responses: {
    getInputMessages: getResponsesInputMessages,
    getOutputMessages: getResponsesOutputMessages,
    publishOutputEvaluation: publishResponsesOutputEvaluation,
  },
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
 * handle binds the per-resource handler so downstream functions never re-dispatch
 * on `baseResource`. Returns null when AI Guard does not apply (no subscribers,
 * non-eligible resource, streaming, or no input messages).
 *
 * @param {string} baseResource - e.g. `'chat.completions'` or `'responses'`
 * @param {object} callArgs - First argument passed to the wrapped OpenAI method
 * @param {boolean} stream - Whether the caller asked for a streamed response
 * @returns {Guard|null}
 */
function createGuard (baseResource, callArgs, stream) {
  // Streaming AI Guard support lands in a follow-up PR. For now, provider-level AI
  // Guard only evaluates non-streaming responses.
  if (stream || !aiguardChannel.hasSubscribers) return null
  const handler = RESOURCE_HANDLERS[baseResource]
  if (!handler) return null

  const inputMessages = handler.getInputMessages(callArgs)
  if (!inputMessages) return null

  let inputEvalPromise
  const guard = { handler, inputMessages, parentSpan: undefined }
  guard.getInputEval = () => (inputEvalPromise ??= publishEvaluation(inputMessages, guard.parentSpan))
  return guard
}

/**
 * Wraps `apiProm.asResponse` so callers that consume the raw `Response` object still
 * receive the Before Model verdict. After Model evaluation is not performed on this
 * path because the response body has not been parsed.
 *
 * @param {object} apiProm - APIPromise returned from the OpenAI SDK method
 * @param {Guard} guard
 */
function wrapAsResponse (apiProm, guard) {
  if (typeof apiProm.asResponse !== 'function') return
  shimmer.wrap(apiProm, 'asResponse', origAsResponse => function (...args) {
    const responsePromise = origAsResponse.apply(this, args)
    return Promise.all([guard.getInputEval(), responsePromise]).then(([, response]) => response)
  })
}

/**
 * Gates the parsed-body promise on Before Model evaluation. Resolves to the SDK's
 * result only once the Before Model verdict is in.
 *
 * @param {Promise<unknown>} parsedPromise
 * @param {Guard} guard
 * @returns {Promise<unknown>}
 */
function gateParse (parsedPromise, guard) {
  return Promise.all([guard.getInputEval(), parsedPromise]).then(([, result]) => result)
}

/**
 * Runs After Model evaluation against the response body.
 *
 * @param {Guard} guard
 * @param {object} body - Parsed OpenAI response body
 * @returns {Promise<unknown>}
 */
function evaluateOutput (guard, body) {
  const outputMessages = guard.handler.getOutputMessages(body)
  if (!outputMessages.length) return Promise.resolve()
  return guard.handler.publishOutputEvaluation(guard.inputMessages, outputMessages, guard.parentSpan)
}

module.exports = {
  hasSubscribers,
  createGuard,
  wrapAsResponse,
  gateParse,
  evaluateOutput,
}
