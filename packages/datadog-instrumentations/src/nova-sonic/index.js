'use strict'

const dc = require('dc-polyfill')

const log = require('../../../dd-trace/src/log')
const SonicSession = require('./session')

const captureChannel = dc.channel('dd-trace:aws:bedrockruntime:sonic:capture-context')
const spanChannel = dc.tracingChannel('apm:aws:bedrockruntime:sonic:span')
const MODEL = 'amazon.nova-2-sonic-v1:0'

function noop () {}

/**
 * @param {object} descriptor
 * @param {(fn: () => void) => void} runInContext
 */
function emitTurn (descriptor, runInContext) {
  const { turn } = descriptor
  const common = { descriptor, model: MODEL }
  runInContext(() => {
    spanChannel.traceSync(() => {
      if (turn.inputStart !== undefined && turn.inputEnd !== undefined && turn.inputEnd >= turn.inputStart) {
        spanChannel.traceSync(noop, {
          ...common, name: 'user speech', kind: 'workflow', startTime: turn.inputStart, finishTime: turn.inputEnd,
        })
      }
      spanChannel.traceSync(noop, {
        ...common,
        name: 'nova sonic response',
        kind: 'llm',
        startTime: descriptor.llmStart,
        finishTime: descriptor.responseEnd,
      })
      const output = turn.output
      if (output.timingValid && output.start !== undefined && output.end > output.start) {
        spanChannel.traceSync(noop, {
          ...common, name: 'agent speech', kind: 'workflow', startTime: output.start, finishTime: output.end,
        })
      }
    }, {
      ...common,
      name: 'nova sonic audio turn',
      kind: 'workflow',
      startTime: descriptor.startTime,
      finishTime: descriptor.finishTime,
    })
  })
}

/**
 * These iterators are application/factory-created objects with no matchable source function.
 * Wrap the concrete iterator, preserving next/return/throw and the SDK's own backpressure/cleanup.
 * No producer is started here; each next delegates exactly once to the original iterator.
 * @param {object} source SDK async iterable.
 * @param {SonicSession} session
 * @param {boolean} outbound
 * @param {(error?: Error) => void} finish
 */
function observeIterable (source, session, outbound, finish) {
  if (typeof source?.[Symbol.asyncIterator] !== 'function') return source
  const rejected = error => {
    finish(error)
    throw error
  }
  return {
    [Symbol.asyncIterator] () {
      let iterator
      try {
        iterator = source[Symbol.asyncIterator]()
      } catch (error) {
        finish(error)
        throw error
      }
      const observed = { [Symbol.asyncIterator] () { return this } }
      for (const method of ['next', 'return', 'throw']) {
        if (typeof iterator[method] !== 'function') continue
        const fulfilled = result => {
          if (result.done || method === 'return') {
            if (!outbound) finish()
          } else {
            session.observe(result.value, outbound)
          }
          return result
        }
        observed[method] = function (...args) {
          try {
            const result = iterator[method](...args)
            return typeof result?.then === 'function' ? result.then(fulfilled, rejected) : fulfilled(result)
          } catch (error) {
            return rejected(error)
          }
        }
      }
      return observed
    },
  }
}

/**
 * Called from the existing Smithy send seam. The bidi operation bypasses the ordinary AWS response
 * accumulator: retaining every chunk there would retain a whole conversation twice.
 * @param {Function} send
 * @param {object} client
 * @param {object} command
 * @param {Array<object | Function>} args
 */
function sendSonic (send, client, command, args) {
  if (command.input?.modelId !== MODEL || !captureChannel.hasSubscribers) return send.call(client, command, ...args)
  const context = {}
  captureChannel.publish(context)
  // Only the LLMObs plugin enables capture; the tracing plugin alone does not buffer conversations.
  if (!context.enabled || !context.runInContext) return send.call(client, command, ...args)
  const session = new SonicSession(descriptor => emitTurn(descriptor, context.runInContext))
  const signal = args[0] !== null && typeof args[0] === 'object' ? args[0]?.abortSignal : undefined
  const finish = error => {
    signal?.removeEventListener('abort', onAbort)
    session.finish(error)
  }
  const onAbort = () => {
    const error = new Error('Nova Sonic request aborted')
    error.name = 'AbortError'
    finish(error)
  }
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })

  const input = command.input
  const observedInput = { ...input, body: observeIterable(input.body, session, true, finish) }
  try {
    command.input = observedInput
  } catch {
    finish()
    log.debug('Cannot observe Nova Sonic input')
    return send.call(client, command, ...args)
  }
  const restoreInput = () => {
    // Middleware can freeze a command while it is in flight; restoration must remain best effort.
    try {
      if (command.input === observedInput) command.input = input
    } catch {
      log.debug('Cannot restore Nova Sonic input')
    }
  }
  const completed = result => {
    restoreInput()
    try {
      if (typeof result?.body?.[Symbol.asyncIterator] === 'function') {
        result.body = observeIterable(result.body, session, false, finish)
      } else {
        finish()
      }
    } catch {
      finish()
      log.debug('Cannot observe Nova Sonic output')
    }
    return result
  }
  const failed = error => {
    restoreInput()
    finish(error)
    throw error
  }
  const callback = args.at(-1)
  if (typeof callback === 'function') {
    args[args.length - 1] = function (error, result) {
      restoreInput()
      if (error) finish(error)
      else completed(result)
      return callback.apply(this, arguments)
    }
  }
  try {
    const result = send.call(client, command, ...args)
    return typeof callback === 'function' ? result : result.then(completed, failed)
  } catch (error) {
    return failed(error)
  }
}

module.exports = sendSonic
