'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')

const {
  WRAPPED,
  invocationChannel,
  wrapHandler,
} = require('../src/aws-lambda')
const {
  HANDLER_STREAMING,
  STREAM_RESPONSE,
} = require('../../datadog-plugin-aws-lambda/src/handler-utils')

describe('aws-lambda instrumentation', () => {
  const subscriptions = []

  afterEach(() => {
    while (subscriptions.length > 0) {
      const [channel, handler] = subscriptions.pop()
      channel.unsubscribe(handler)
    }
  })

  function subscribe (channel, handler) {
    channel.subscribe(handler)
    subscriptions.push([channel, handler])
  }

  it('returns the same wrapper when the customer handler is wrapped twice', () => {
    const handler = () => 'result'
    const wrapped = wrapHandler(handler)

    assert.strictEqual(handler[WRAPPED], wrapped)
    assert.strictEqual(wrapped[WRAPPED], wrapped)
    // Both the layer and the NODE_OPTIONS path resolve the same customer handler, so the guard has
    // to hand back the instrumented function. Returning `handler` here would silently drop tracing.
    assert.strictEqual(wrapHandler(handler), wrapped)
    assert.strictEqual(wrapHandler(wrapped), wrapped)
  })

  it('does not claim datadog-lambda-js\'s _ddWrapped marker', () => {
    const handler = () => 'result'
    const wrapped = wrapHandler(handler)

    // The released shim returns early when this property is set, which would suppress its
    // extractors, inferred spans, enhanced metrics, log injection and cold-start tracing.
    assert.strictEqual(handler._ddWrapped, undefined)
    assert.strictEqual(wrapped._ddWrapped, undefined)
  })

  it('resolves a synchronous handler invoked with the runtime callback', async () => {
    // The AWS runtime always supplies a callback in the third argument. A handler whose declared
    // arity is below 3 never calls it, so the lifecycle must not wait for it.
    const context = { getRemainingTimeInMillis: () => 100 }
    const runtimeCallback = () => {}

    assert.deepStrictEqual(
      await Promise.all([
        wrapHandler((_event, _context) => 'two-arg')({}, context, runtimeCallback),
        wrapHandler((_event) => 'one-arg')({}, context, runtimeCallback),
      ]),
      ['two-arg', 'one-arg']
    )
  })

  it('rejects on a falsy but non-nullish callback error', async () => {
    const context = { getRemainingTimeInMillis: () => 100 }
    const handler = wrapHandler((_event, _context, callback) => {
      callback('', 'unreachable') // eslint-disable-line n/no-callback-literal
    })

    await assert.rejects(handler({}, context, () => {}), (error) => error === '')
  })

  it('publishes one lifecycle for a synchronous handler', async () => {
    const events = []
    for (const name of ['start', 'end', 'asyncStart', 'asyncEnd']) {
      subscribe(invocationChannel[name], () => events.push(name))
    }

    const result = await wrapHandler(() => 'result')({})

    assert.strictEqual(result, 'result')
    assert.deepStrictEqual(events, ['start', 'end', 'asyncStart', 'asyncEnd'])
  })

  it('uses the first completion between callback and returned promise', async () => {
    const callbackFirst = wrapHandler((_event, _context, callback) => {
      callback(undefined, 'callback')
      return Promise.resolve('promise')
    })
    const promiseFirst = wrapHandler((_event, _context, callback) => {
      setImmediate(() => callback(undefined, 'callback'))
      return Promise.resolve('promise')
    })

    assert.strictEqual(await callbackFirst({}, {}, () => {}), 'callback')
    assert.strictEqual(await promiseFirst({}, {}, () => {}), 'promise')
  })

  it('normalizes a synchronous throw through the complete async lifecycle', async () => {
    const events = []
    for (const name of ['start', 'end', 'error', 'asyncStart', 'asyncEnd']) {
      subscribe(invocationChannel[name], () => events.push(name))
    }
    const handler = wrapHandler(() => {
      throw new Error('synchronous failure')
    })

    await assert.rejects(handler({}), { message: 'synchronous failure' })
    assert.deepStrictEqual(events, ['start', 'end', 'error', 'asyncStart', 'asyncEnd'])
  })

  it('rejects rather than throwing when a streaming handler throws synchronously', async () => {
    const events = []
    for (const name of ['start', 'end', 'error', 'asyncStart', 'asyncEnd']) {
      subscribe(invocationChannel[name], () => events.push(name))
    }
    const handler = (_event, _stream, _context) => {
      throw new Error('streaming failure')
    }
    handler[HANDLER_STREAMING] = STREAM_RESPONSE
    const context = { getRemainingTimeInMillis: () => 100 }

    // A synchronous throw out of the wrapper would skip asyncStart/asyncEnd, leaving the span
    // unfinished and the impending-timeout timer armed.
    await assert.rejects(wrapHandler(handler)({}, {}, context), { message: 'streaming failure' })
    assert.deepStrictEqual(events, ['start', 'end', 'error', 'asyncStart', 'asyncEnd'])
  })

  it('preserves the response-streaming marker and arguments', async () => {
    const calls = []
    const handler = (event, stream, context) => {
      calls.push(event, stream, context)
      return Promise.resolve('streamed')
    }
    handler[HANDLER_STREAMING] = STREAM_RESPONSE

    const wrapped = wrapHandler(handler)
    const stream = {}
    const context = { getRemainingTimeInMillis: () => 100 }

    assert.strictEqual(wrapped[HANDLER_STREAMING], STREAM_RESPONSE)
    assert.strictEqual(await wrapped('event', stream, context), 'streamed')
    assert.deepStrictEqual(calls, ['event', stream, context])
  })
})
