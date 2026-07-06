'use strict'

const { channel } = require('dc-polyfill')

const { getMessagesInputMessages, getMessagesOutputMessages } = require('../messages/anthropic')
const { SOURCE_AUTO } = require('../tags')
const { pushEvaluation } = require('./evaluate')

const messagesBeforeChannel = channel('dd-trace:anthropic:messages:before')
const messagesAfterChannel = channel('dd-trace:anthropic:messages:after')

let isEnabled = false
let aiguard
let opts

/**
 * Subscribes AI Guard to Anthropic lifecycle channels.
 *
 * @param {object} aiguardInstance
 * @param {boolean} block
 */
function enable (aiguardInstance, block) {
  if (isEnabled) return

  aiguard = aiguardInstance
  opts = { block, source: SOURCE_AUTO, integration: 'anthropic' }

  messagesBeforeChannel.subscribe(onMessagesBefore)
  messagesAfterChannel.subscribe(onMessagesAfter)

  isEnabled = true
}

function disable () {
  if (!isEnabled) return

  messagesBeforeChannel.unsubscribe(onMessagesBefore)
  messagesAfterChannel.unsubscribe(onMessagesAfter)

  aiguard = undefined
  opts = undefined
  isEnabled = false
}

function onMessagesBefore (ctx) {
  pushEvaluation(ctx, aiguard, getMessagesInputMessages(ctx.args?.[0]), opts)
}

function onMessagesAfter (ctx) {
  const inputMessages = getMessagesInputMessages(ctx.args?.[0])
  if (!inputMessages?.length) return

  const outputMessages = getMessagesOutputMessages(ctx.body)
  if (!outputMessages.length) return

  pushEvaluation(ctx, aiguard, [...inputMessages, ...outputMessages], opts)
}

module.exports = { enable, disable }
