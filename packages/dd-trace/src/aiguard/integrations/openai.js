'use strict'

const { channel } = require('dc-polyfill')

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

const chatCompletionsInterceptChannel = channel('dd-trace:openai:chat.completions:intercept')
const responsesInterceptChannel = channel('dd-trace:openai:responses:intercept')

let isEnabled = false
let aiguard
let opts
let analyzeStreamResponses

/**
 * Subscribes AI Guard to the OpenAI interception channels.
 *
 * @param {object} aiguardInstance
 * @param {boolean} block
 * @param {boolean} analyzeStreams
 */
function enable (aiguardInstance, block, analyzeStreams) {
  if (isEnabled) return

  aiguard = aiguardInstance
  opts = { block, source: SOURCE_AUTO, integration: 'openai' }
  analyzeStreamResponses = analyzeStreams

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
  isEnabled = false
}

function onChatCompletions (ctx) {
  const inputMessages = getChatCompletionsInputMessages(ctx.arguments?.[0])
  if (!inputMessages?.length) return

  let inputEvaluation
  ctx.beforeResult = () => {
    if (!isEnabled) return
    inputEvaluation ??= evaluate(ctx, aiguard, [inputMessages], opts)
    return inputEvaluation
  }

  const isStream = ctx.arguments[0].stream
  if (isStream && !analyzeStreamResponses) return

  let outputEvaluation
  ctx.onResult = body => {
    if (!isEnabled) return body

    if (isStream) {
      outputEvaluation ??= interceptStream(body, chunks => {
        return getStreamedChatCompletionsOutputMessages(chunks)
          .map(message => [...inputMessages, message])
      }, ctx)
      return outputEvaluation
    }

    const conversations = decode(
      () => getChatCompletionsOutputMessages(body).map(message => [...inputMessages, message]),
      null,
      'AIGuard: unable to decode OpenAI response body: %s'
    )
    if (!conversations?.length) return body

    outputEvaluation ??= evaluate(ctx, aiguard, conversations, opts)
    return outputEvaluation.then(() => body)
  }
}

function onResponses (ctx) {
  const inputMessages = getResponsesInputMessages(ctx.arguments?.[0])
  if (!inputMessages?.length) return

  let inputEvaluation
  ctx.beforeResult = () => {
    if (!isEnabled) return
    inputEvaluation ??= evaluate(ctx, aiguard, [inputMessages], opts)
    return inputEvaluation
  }

  const isStream = ctx.arguments[0].stream
  if (isStream && !analyzeStreamResponses) return

  let outputEvaluation
  ctx.onResult = body => {
    if (!isEnabled) return body

    if (isStream) {
      outputEvaluation ??= interceptStream(body, chunks => {
        const outputMessages = getStreamedResponsesOutputMessages(chunks)
        return outputMessages.length ? [[...inputMessages, ...outputMessages]] : []
      }, ctx)
      return outputEvaluation
    }

    const outputMessages = decode(
      () => getResponsesOutputMessages(body),
      null,
      'AIGuard: unable to decode OpenAI response body: %s'
    )
    if (!outputMessages?.length) return body

    outputEvaluation ??= evaluate(ctx, aiguard, [[...inputMessages, ...outputMessages]], opts)
    return outputEvaluation.then(() => body)
  }
}

/**
 * Uses the OpenAI SDK's stream splitting support to evaluate one branch and return the other.
 *
 * @param {object} stream
 * @param {(chunks: Array<object>) => Array<Array<object>>} getConversations
 * @param {object} ctx
 * @returns {object|Promise<object>}
 */
function interceptStream (stream, getConversations, ctx) {
  if (typeof stream?.tee !== 'function') return stream

  let branches
  try {
    branches = stream.tee()
  } catch {
    return stream
  }

  const [evaluationStream, resultStream] = branches
  return drainStream(evaluationStream).then(chunks => {
    if (!isEnabled) return resultStream
    const conversations = decode(
      () => getConversations(chunks),
      null,
      'AIGuard: unable to decode the streamed OpenAI response: %s'
    )
    if (!conversations?.length) return resultStream
    return evaluate(ctx, aiguard, conversations, opts).then(() => resultStream)
  }, () => resultStream)
}

/**
 * @param {object} stream
 * @returns {Promise<Array<object>>}
 */
function drainStream (stream) {
  const chunks = []
  const iterator = stream[Symbol.asyncIterator]()

  function readAll () {
    return iterator.next().then(({ done, value }) => {
      if (done) return chunks
      chunks.push(value)
      return readAll()
    })
  }

  return readAll()
}

module.exports = { enable, disable }
