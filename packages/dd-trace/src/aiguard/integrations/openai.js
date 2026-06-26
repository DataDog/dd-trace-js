'use strict'

const { channel } = require('dc-polyfill')

const {
  getChatCompletionsInputMessages,
  getChatCompletionsOutputMessages,
  getResponsesInputMessages,
  getResponsesOutputMessages,
} = require('../messages/openai')
const { SOURCE_AUTO } = require('../tags')
const { pushEvaluation } = require('./evaluate')

const chatCompletionsBeforeChannel = channel('dd-trace:openai:chat.completions:before')
const chatCompletionsAfterChannel = channel('dd-trace:openai:chat.completions:after')
const responsesBeforeChannel = channel('dd-trace:openai:responses:before')
const responsesAfterChannel = channel('dd-trace:openai:responses:after')

/**
 * Subscribes AI Guard to OpenAI lifecycle channels.
 *
 * @param {object} aiguard
 * @param {boolean} block
 * @returns {() => void}
 */
function enable (aiguard, block) {
  const opts = { block, source: SOURCE_AUTO, integration: 'openai' }

  function onChatCompletionsBefore (ctx) {
    pushEvaluation(ctx, aiguard, getChatCompletionsInputMessages(ctx.args?.[0]), opts)
  }

  function onChatCompletionsAfter (ctx) {
    const inputMessages = getChatCompletionsInputMessages(ctx.args?.[0])
    if (!inputMessages?.length) return
    for (const message of getChatCompletionsOutputMessages(ctx.body)) {
      pushEvaluation(ctx, aiguard, [...inputMessages, message], opts)
    }
  }

  function onResponsesBefore (ctx) {
    pushEvaluation(ctx, aiguard, getResponsesInputMessages(ctx.args?.[0]), opts)
  }

  function onResponsesAfter (ctx) {
    const inputMessages = getResponsesInputMessages(ctx.args?.[0])
    if (!inputMessages?.length) return
    const outputMessages = getResponsesOutputMessages(ctx.body)
    if (!outputMessages.length) return
    pushEvaluation(ctx, aiguard, [...inputMessages, ...outputMessages], opts)
  }

  chatCompletionsBeforeChannel.subscribe(onChatCompletionsBefore)
  chatCompletionsAfterChannel.subscribe(onChatCompletionsAfter)
  responsesBeforeChannel.subscribe(onResponsesBefore)
  responsesAfterChannel.subscribe(onResponsesAfter)

  return function disable () {
    chatCompletionsBeforeChannel.unsubscribe(onChatCompletionsBefore)
    chatCompletionsAfterChannel.unsubscribe(onChatCompletionsAfter)
    responsesBeforeChannel.unsubscribe(onResponsesBefore)
    responsesAfterChannel.unsubscribe(onResponsesAfter)
  }
}

module.exports = { enable }
