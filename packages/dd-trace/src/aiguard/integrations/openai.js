'use strict'

const { channel } = require('dc-polyfill')

const log = require('../../log')
const {
  getChatCompletionsInputMessages,
  getChatCompletionsOutputMessages,
  getResponsesInputMessages,
  getResponsesOutputMessages,
} = require('../messages/openai')
const { SOURCE_AUTO } = require('../tags')
const { evaluate } = require('./evaluate')

const chatCompletionsInterceptChannel = channel('dd-trace:openai:chat.completions:intercept')
const responsesInterceptChannel = channel('dd-trace:openai:responses:intercept')

let isEnabled = false
let aiguard
let opts

/**
 * Subscribes AI Guard to the OpenAI interception channels.
 *
 * @param {object} aiguardInstance
 * @param {boolean} block
 */
function enable (aiguardInstance, block) {
  if (isEnabled) return

  aiguard = aiguardInstance
  opts = { block, source: SOURCE_AUTO, integration: 'openai' }

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
  isEnabled = false
}

function onChatCompletions (ctx) {
  const inputMessages = getChatCompletionsInputMessages(ctx.arguments?.[0])
  if (!inputMessages?.length) return

  // `parse` and `asResponse` are both wrapped, and either may run more than once per call.
  let inputEvaluation
  ctx.beforeResult = () => (inputEvaluation ??= evaluate(ctx, aiguard, [inputMessages], opts))

  // One model call has one output however many readers observe it.
  let outputEvaluation
  ctx.onResult = body => {
    let conversations
    try {
      conversations = getChatCompletionsOutputMessages(body).map(message => [...inputMessages, message])
    } catch (error) {
      // This runs in the caller's promise chain, so an unexpected payload must not fail their call.
      log.error('AIGuard: unable to decode OpenAI response body: %s', error.message)
      return body
    }

    if (conversations.length === 0) return body

    outputEvaluation ??= evaluate(ctx, aiguard, conversations, opts)
    return outputEvaluation.then(() => body)
  }
}

function onResponses (ctx) {
  const inputMessages = getResponsesInputMessages(ctx.arguments?.[0])
  if (!inputMessages?.length) return

  let inputEvaluation
  ctx.beforeResult = () => (inputEvaluation ??= evaluate(ctx, aiguard, [inputMessages], opts))

  let outputEvaluation
  ctx.onResult = body => {
    let outputMessages
    try {
      outputMessages = getResponsesOutputMessages(body)
    } catch (error) {
      log.error('AIGuard: unable to decode OpenAI response body: %s', error.message)
      return body
    }

    if (!outputMessages.length) return body

    outputEvaluation ??= evaluate(ctx, aiguard, [[...inputMessages, ...outputMessages]], opts)
    return outputEvaluation.then(() => body)
  }
}

module.exports = { enable, disable }
