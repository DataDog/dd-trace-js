'use strict'

const { channel } = require('dc-polyfill')

const log = require('../../log')
const {
  buildOutputMessages,
  convertVercelPromptToMessages,
  getStreamedContent,
} = require('../messages/vercel-ai')
const { SOURCE_AUTO } = require('../tags')
const { evaluate } = require('./evaluate')

const modelInterceptChannel = channel('dd-trace:vercel-ai:model:intercept')

let isEnabled = false
let aiguard
let opts

/**
 * Subscribes AI Guard to the Vercel AI model call channel.
 *
 * @param {object} aiguardInstance
 * @param {boolean} block
 */
function enable (aiguardInstance, block) {
  if (isEnabled) return

  aiguard = aiguardInstance
  opts = { block, source: SOURCE_AUTO, integration: 'ai' }

  modelInterceptChannel.subscribe(onModelIntercept)

  isEnabled = true
}

function disable () {
  if (!isEnabled) return

  modelInterceptChannel.unsubscribe(onModelIntercept)

  aiguard = undefined
  opts = undefined
  isEnabled = false
}

function onModelIntercept (ctx) {
  const inputMessages = convertVercelPromptToMessages(ctx.arguments?.[0]?.prompt)
  if (!inputMessages.length) return

  // Called exactly once per model call by the instrumentation, so no memoization needed.
  ctx.beforeResult = () => evaluate(ctx, aiguard, [inputMessages], opts)

  ctx.onResult = ctx.method === 'doStream'
    ? result => interceptStreamedResult(ctx, result, inputMessages)
    : result => {
      let outputMessages
      try {
        outputMessages = buildOutputMessages(inputMessages, result?.content ?? [])
      } catch (error) {
        // This runs in the caller's promise chain, so an unexpected payload must not fail their call.
        log.error('AIGuard: unable to decode the model result: %s', error.message)
        return result
      }

      if (!outputMessages.length) return result

      return evaluate(ctx, aiguard, [outputMessages], opts).then(() => result)
    }
}

/**
 * Judging a streamed response requires the whole output, so the stream is drained and replaced
 * with a replay of the collected chunks. That trades streaming latency for output coverage.
 *
 * @param {object} ctx
 * @param {object} result
 * @param {Array<object>} inputMessages
 * @returns {object|Promise<object>}
 */
function interceptStreamedResult (ctx, result, inputMessages) {
  if (!result?.stream) return result

  let drained
  try {
    drained = drainStream(result.stream)
  } catch {
    // Nothing was consumed, so the caller still has the stream they handed us.
    return result
  }

  return drained.then(({ chunks, error }) => {
    // The original stream is spent from here on, so the caller must get the replay either way.
    const replayed = { ...result, stream: replayChunks(chunks, error) }

    // A stream that failed part-way has no complete output to judge; the replay carries the error.
    if (error) return replayed

    let outputMessages
    try {
      outputMessages = buildOutputMessages(inputMessages, getStreamedContent(chunks))
    } catch (error) {
      log.error('AIGuard: unable to decode the streamed model result: %s', error.message)
      return replayed
    }

    if (!outputMessages.length) return replayed

    return evaluate(ctx, aiguard, [outputMessages], opts).then(() => replayed)
  })
}

/**
 * Never rejects: a stream that fails part-way is already consumed, so its chunks and its error
 * are both returned for the replay to hand back to the caller.
 *
 * @param {ReadableStream} stream
 * @returns {Promise<{ chunks: Array<object>, error?: unknown }>}
 */
function drainStream (stream) {
  const chunks = []
  const reader = stream.getReader()

  function readAll () {
    return reader.read().then(({ done, value }) => {
      if (done) return { chunks }
      chunks.push(value)
      return readAll()
    }, error => ({ chunks, error }))
  }

  return readAll()
}

/**
 * @param {Array<object>} chunks
 * @param {unknown} [error]
 * @returns {ReadableStream}
 */
function replayChunks (chunks, error) {
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  return new ReadableStream({
    start (controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk)
      }
      if (error) {
        controller.error(error)
      } else {
        controller.close()
      }
    },
  })
}

module.exports = { enable, disable }
