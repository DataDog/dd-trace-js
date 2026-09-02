'use strict'

const { channel } = require('dc-polyfill')

const log = require('../../log')
const { getMessagesInputMessages, getMessagesOutputMessages } = require('../messages/anthropic')
const { SOURCE_AUTO } = require('../tags')
const { evaluate } = require('./evaluate')

const messagesPrepareChannel = channel('dd-trace:anthropic:messages:prepare')
const messagesInterceptChannel = channel('dd-trace:anthropic:messages:intercept')

let isEnabled = false
let aiguard
let opts

/**
 * Subscribes AI Guard to the Anthropic interception channels.
 *
 * @param {object} aiguardInstance
 * @param {boolean} block
 */
function enable (aiguardInstance, block) {
  if (isEnabled) return

  aiguard = aiguardInstance
  opts = { block, source: SOURCE_AUTO, integration: 'anthropic' }

  messagesPrepareChannel.subscribe(onMessagesPrepare)
  messagesInterceptChannel.subscribe(onMessagesIntercept)

  isEnabled = true
}

function disable () {
  if (!isEnabled) return

  messagesPrepareChannel.unsubscribe(onMessagesPrepare)
  messagesInterceptChannel.unsubscribe(onMessagesIntercept)

  aiguard = undefined
  opts = undefined
  isEnabled = false
}

/**
 * Replaces the outgoing options with a JSON snapshot of the evaluated fields, so AI Guard judges
 * exactly what the SDK serializes and sends, immune to later caller mutation.
 *
 * @param {{ arguments: Array<unknown> }} ctx
 */
function onMessagesPrepare (ctx) {
  const options = ctx.arguments[0]
  if (!options || typeof options !== 'object') return

  const evaluated = { messages: options.messages }
  if (options.system !== undefined) evaluated.system = options.system

  try {
    // eslint-disable-next-line unicorn/prefer-structured-clone
    ctx.arguments[0] = { ...options, ...JSON.parse(JSON.stringify(evaluated)) }
  } catch {
    // Unserializable input — judge the caller's options as they are.
  }
}

function onMessagesIntercept (ctx) {
  const inputMessages = getMessagesInputMessages(ctx.arguments?.[0])
  if (!inputMessages?.length) return

  // `parse` and `asResponse` are both wrapped, and either may run more than once per call.
  let inputEvaluation
  ctx.beforeResult = () => (inputEvaluation ??= evaluate(ctx, aiguard, [inputMessages], opts))

  // One model call has one output however many readers observe it: `parse`, `json()`, `text()`
  // and every `clone()` of the raw response share this callback.
  let outputEvaluation
  ctx.onResult = body => {
    let outputMessages
    try {
      outputMessages = getMessagesOutputMessages(body)
    } catch (error) {
      // This runs in the caller's promise chain, so an unexpected payload must not fail their call.
      log.error('AIGuard: unable to decode Anthropic response body: %s', error.message)
      return body
    }

    if (!outputMessages.length) return body

    outputEvaluation ??= evaluate(ctx, aiguard, [[...inputMessages, ...outputMessages]], opts)
    return outputEvaluation.then(() => body)
  }
}

module.exports = { enable, disable }
