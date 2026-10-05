'use strict'

const dc = require('dc-polyfill')

const log = require('../../../dd-trace/src/log')
const { storage } = require('../../../datadog-core')
const SonicSession = require('./session')

const captureChannel = dc.channel('dd-trace:aws:bedrockruntime:sonic:capture-context')
const spanChannel = dc.tracingChannel('apm:aws:bedrockruntime:sonic:span')
const MODEL = 'amazon.nova-2-sonic-v1:0'
const sessionStorage = storage('nova-sonic')
const instrumentedClients = new WeakSet()

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

/** @param {object} client */
function instrumentInput (client) {
  if (instrumentedClients.has(client)) return true
  try {
    // Install before even an uncaptured send can cache the SDK handler. Cached handlers must
    // look up the invocation's session at execution time, not retain the first session.
    client.middlewareStack.add((next, context) => args => {
      const capture = sessionStorage.getStore()
      if (capture?.client !== client || context.commandName !== 'InvokeModelWithBidirectionalStreamCommand') {
        return next(args)
      }
      const { session, finish } = capture
      const input = { ...args.input, body: observeIterable(args.input.body, session, true, finish) }
      // Smithy passes the shared Command as args. Copy it before asynchronous middleware can
      // read input, so overlapping sends never modify the command or observe another session.
      return next({ ...args, input })
    }, { name: 'datadogSonicInput', step: 'initialize', priority: 'high' })
    instrumentedClients.add(client)
    return true
  } catch {
    log.debug('Cannot observe Nova Sonic input')
    return false
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
  const instrumented = instrumentInput(client)
  const passthrough = () => sessionStorage.run(undefined, () => send.call(client, command, ...args))
  if (!instrumented || command.input?.modelId !== MODEL || !captureChannel.hasSubscribers) return passthrough()
  const context = {}
  captureChannel.publish(context)
  // Only the LLMObs plugin enables capture; the tracing plugin alone does not buffer conversations.
  if (!context.enabled || !context.runInContext) return passthrough()
  const session = new SonicSession(descriptor => emitTurn(descriptor, context.runInContext))
  const signal = args[0] !== null && typeof args[0] === 'object' ? args[0]?.abortSignal : undefined
  // Smithy's legacy AbortSignal only exposes onabort; leave that slot to the SDK's transport.
  const hasListeners = typeof signal?.addEventListener === 'function' &&
    typeof signal?.removeEventListener === 'function'
  const finish = error => {
    if (hasListeners) signal.removeEventListener('abort', onAbort)
    // Aborting an already delivered HTTP/2 response can surface as clean iterator EOF.
    if (!error && signal?.aborted) {
      error = new Error('Nova Sonic request aborted')
      error.name = 'AbortError'
    }
    session.finish(error)
  }
  const onAbort = () => finish()
  if (signal?.aborted) onAbort()
  else if (hasListeners) signal.addEventListener('abort', onAbort, { once: true })

  const completed = result => {
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
    finish(error)
    throw error
  }
  const callback = args.at(-1)
  if (typeof callback === 'function') {
    args[args.length - 1] = function (error, result) {
      if (error) finish(error)
      else completed(result)
      return callback.apply(this, arguments)
    }
  }
  try {
    const result = sessionStorage.run({ client, session, finish }, () => send.call(client, command, ...args))
    return typeof callback === 'function' ? result : result.then(completed, failed)
  } catch (error) {
    return failed(error)
  }
}

module.exports = sendSonic
