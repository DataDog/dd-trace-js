'use strict'

const { channel } = require('dc-polyfill')

const log = require('../../log')
const { linkMcpTools } = require('../mcp')
const {
  getChatCompletionsInputMessages,
  getChatCompletionsOutputMessages,
  getResponsesInputMessages,
  getResponsesOutputMessages,
  getStreamedChatCompletionsOutputMessages,
  getStreamedResponsesOutputMessages,
} = require('../messages/openai')
const { decode } = require('../messages/utils')
const { SOURCE_AUTO } = require('../tags')
const { evaluate } = require('./evaluate')
const { interceptStream } = require('./stream')

const chatCompletionsInterceptChannel = channel('dd-trace:openai:chat.completions:intercept')
const responsesInterceptChannel = channel('dd-trace:openai:responses:intercept')

let isEnabled = false
let aiguard
let opts
let analyzeStreamResponses
let mcpEnabled

/**
 * Subscribes AI Guard to the OpenAI interception channels.
 *
 * @param {object} aiguardInstance
 * @param {boolean} block
 * @param {boolean} analyzeStreams
 * @param {boolean} [mcp] Whether to link client-managed MCP tools to the evaluated tool calls.
 */
function enable (aiguardInstance, block, analyzeStreams, mcp) {
  if (isEnabled) return

  aiguard = aiguardInstance
  opts = { block, source: SOURCE_AUTO, integration: 'openai' }
  analyzeStreamResponses = analyzeStreams
  mcpEnabled = mcp === true

  chatCompletionsInterceptChannel.subscribe(onChatCompletions)
  responsesInterceptChannel.subscribe(onResponses)

  isEnabled = true
}

function disable () {
  if (!isEnabled) return

  chatCompletionsInterceptChannel.unsubscribe(onChatCompletions)
  responsesInterceptChannel.unsubscribe(onResponses)

  aiguard = undefined
  opts = undefined
  analyzeStreamResponses = undefined
  mcpEnabled = undefined
  isEnabled = false
}

/**
 * @param {{ type?: unknown, function?: { name?: unknown, parameters?: unknown } }} tool
 */
function getChatCompletionsFunction (tool) {
  return tool.type === 'function' ? tool.function : undefined
}

/**
 * @param {{ type?: unknown, name?: unknown, parameters?: unknown }} tool
 */
function getResponsesFunction (tool) {
  return tool.type === 'function' ? tool : undefined
}

/**
 * Selects the chat completions tool calls of function tools. Some compatible providers, and history
 * that an application builds, leave out the type of a function tool call.
 *
 * @param {{ type?: unknown, function?: unknown }} toolCall
 */
function isChatCompletionsFunctionCall (toolCall) {
  if (toolCall.type !== undefined) return toolCall.type === 'function'
  return toolCall.function !== null && typeof toolCall.function === 'object'
}

/**
 * Returns a filter for the tool calls that come from Responses API function_call items. Other items,
 * for example hosted MCP calls, convert to tool calls too, but they never run on a client server.
 *
 * @param {unknown} items The input or output items of a response.
 * @returns {(toolCall: { id?: unknown }) => boolean}
 */
function getResponsesFunctionCallFilter (items) {
  const callIds = new Set()
  if (Array.isArray(items)) {
    for (const item of items) {
      if (item?.type === 'function_call' && typeof item.call_id === 'string') callIds.add(item.call_id)
    }
  }
  return toolCall => callIds.has(toolCall.id)
}

/**
 * Links the client-managed MCP tools of a request. Without a link, the evaluations stay generic.
 *
 * @param {object} ctx
 * @param {(tool: object) => { name?: unknown, parameters?: unknown }|undefined} getFunction
 * @returns {import('../mcp').McpToolLink|undefined}
 */
function getMcpLink (ctx, getFunction) {
  if (!mcpEnabled) return

  let link
  try {
    link = linkMcpTools(ctx.arguments[0].tools, getFunction, ctx)
  } catch (error) {
    log.debug('AIGuard: unable to link the MCP tools of the OpenAI request: %s', error.message)
  }
  return link
}

/**
 * Evaluates each chat completion choice as its own conversation.
 *
 * @param {object} ctx
 * @param {Array<object>} input The evaluated input messages.
 * @param {Array<object>} outputMessages One output message for each choice.
 * @param {import('../mcp').McpToolLink|undefined} mcpLink
 * @returns {Promise<void>|undefined}
 */
function evaluateChatCompletionsOutputs (ctx, input, outputMessages, mcpLink) {
  if (!mcpLink) return evaluate(ctx, aiguard, outputMessages.map(message => [...input, message]), opts)
  const outputs = outputMessages.map(message => [message])
  return evaluateMcpOutputs(ctx, input, outputs, mcpLink, isChatCompletionsFunctionCall)
}

/**
 * Evaluates the output items of a response as one conversation.
 *
 * @param {object} ctx
 * @param {Array<object>} input The evaluated input messages.
 * @param {Array<object>} outputMessages
 * @param {import('../mcp').McpToolLink|undefined} mcpLink
 * @param {unknown} outputItems The output items that the messages come from.
 * @returns {Promise<void>|undefined}
 */
function evaluateResponsesOutputs (ctx, input, outputMessages, mcpLink, outputItems) {
  if (!mcpLink) return evaluate(ctx, aiguard, [[...input, ...outputMessages]], opts)
  return evaluateMcpOutputs(ctx, input, [outputMessages], mcpLink, getResponsesFunctionCallFilter(outputItems))
}

/**
 * Evaluates the output conversations with their MCP metadata. Each evaluation that allows its
 * output marks the MCP tool calls of that output.
 *
 * @param {object} ctx
 * @param {Array<object>} input The evaluated input messages.
 * @param {Array<Array<object>>} outputs The output messages of each conversation.
 * @param {import('../mcp').McpToolLink} mcpLink
 * @param {(toolCall: object) => boolean} isFunctionCall Selects the tool calls of function tools.
 * @returns {Promise<void>|undefined}
 */
function evaluateMcpOutputs (ctx, input, outputs, mcpLink, isFunctionCall) {
  const conversations = []
  const mcp = []
  for (const output of outputs) {
    const attached = mcpLink.attach(output, isFunctionCall)
    const conversation = [...input, ...attached]
    conversations.push(conversation)
    mcp.push(mcpLink.evaluation(conversation, attached))
  }
  return evaluate(ctx, aiguard, conversations, opts, mcp)
}

function onChatCompletions (ctx) {
  const inputMessages = getChatCompletionsInputMessages(ctx.arguments?.[0])
  if (!inputMessages?.length) return

  const mcpLink = getMcpLink(ctx, getChatCompletionsFunction)
  const input = mcpLink ? mcpLink.attach(inputMessages, isChatCompletionsFunctionCall) : inputMessages

  let inputEvaluation
  ctx.beforeResult = () => {
    if (!isEnabled) return
    inputEvaluation ??= evaluate(ctx, aiguard, [input], opts, mcpLink && [mcpLink.evaluation(input)])
    return inputEvaluation
  }

  const isStream = ctx.arguments[0].stream
  if (isStream && !analyzeStreamResponses) return

  let outputEvaluation
  ctx.onResult = body => {
    if (!isEnabled) return body

    if (isStream) {
      outputEvaluation ??= interceptStream(body, chunks => {
        if (!isEnabled) return
        const outputMessages = decode(
          () => getStreamedChatCompletionsOutputMessages(chunks),
          null,
          'AIGuard: unable to decode the streamed OpenAI response: %s'
        )
        if (!outputMessages?.length) return
        return evaluateChatCompletionsOutputs(ctx, input, outputMessages, mcpLink)
      })
      return outputEvaluation
    }

    const outputMessages = decode(
      () => getChatCompletionsOutputMessages(body),
      null,
      'AIGuard: unable to decode OpenAI response body: %s'
    )
    if (!outputMessages?.length) return body

    outputEvaluation ??= evaluateChatCompletionsOutputs(ctx, input, outputMessages, mcpLink)
    return outputEvaluation.then(() => body)
  }
}

function onResponses (ctx) {
  const inputMessages = getResponsesInputMessages(ctx.arguments?.[0])
  if (!inputMessages?.length) return

  const mcpLink = getMcpLink(ctx, getResponsesFunction)
  const input = mcpLink
    ? mcpLink.attach(inputMessages, getResponsesFunctionCallFilter(ctx.arguments[0].input))
    : inputMessages

  let inputEvaluation
  ctx.beforeResult = () => {
    if (!isEnabled) return
    inputEvaluation ??= evaluate(ctx, aiguard, [input], opts, mcpLink && [mcpLink.evaluation(input)])
    return inputEvaluation
  }

  const isStream = ctx.arguments[0].stream
  if (isStream && !analyzeStreamResponses) return

  let outputEvaluation
  ctx.onResult = body => {
    if (!isEnabled) return body

    if (isStream) {
      outputEvaluation ??= interceptStream(body, chunks => {
        if (!isEnabled) return
        const outputMessages = decode(
          () => getStreamedResponsesOutputMessages(chunks),
          null,
          'AIGuard: unable to decode the streamed OpenAI response: %s'
        )
        if (!outputMessages?.length) return
        return evaluateResponsesOutputs(ctx, input, outputMessages, mcpLink, chunks.at(-1)?.response?.output)
      })
      return outputEvaluation
    }

    const outputMessages = decode(
      () => getResponsesOutputMessages(body),
      null,
      'AIGuard: unable to decode OpenAI response body: %s'
    )
    if (!outputMessages?.length) return body

    outputEvaluation ??= evaluateResponsesOutputs(ctx, input, outputMessages, mcpLink, body?.output)
    return outputEvaluation.then(() => body)
  }
}

module.exports = { enable, disable }
