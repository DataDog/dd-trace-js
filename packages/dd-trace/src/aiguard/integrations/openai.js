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

let isEnabled = false
let aiguard
let opts

/**
 * Subscribes AI Guard to OpenAI lifecycle channels.
 *
 * @param {object} aiguardInstance
 * @param {boolean} block
 */
function enable (aiguardInstance, block) {
  if (isEnabled) return

  aiguard = aiguardInstance
  opts = { block, source: SOURCE_AUTO, integration: 'openai' }

  chatCompletionsBeforeChannel.subscribe(onChatCompletionsBefore)
  chatCompletionsAfterChannel.subscribe(onChatCompletionsAfter)
  responsesBeforeChannel.subscribe(onResponsesBefore)
  responsesAfterChannel.subscribe(onResponsesAfter)

  isEnabled = true
}

function disable () {
  if (!isEnabled) return

  chatCompletionsBeforeChannel.unsubscribe(onChatCompletionsBefore)
  chatCompletionsAfterChannel.unsubscribe(onChatCompletionsAfter)
  responsesBeforeChannel.unsubscribe(onResponsesBefore)
  responsesAfterChannel.unsubscribe(onResponsesAfter)

  aiguard = undefined
  opts = undefined
  isEnabled = false
}

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

module.exports = { enable, disable }
