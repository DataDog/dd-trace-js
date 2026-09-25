'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { withTimeoutMonitor } = require('../../src/lambda/handler')
const { HANDLER_STREAMING, STREAM_RESPONSE } = require('../../../datadog-plugin-aws-lambda/src/handler-utils')

describe('Lambda timeout monitor', () => {
  let clock
  let originalTracer
  let killAll
  let span
  let context

  beforeEach(() => {
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    originalTracer = global._ddtrace
    killAll = sinon.spy()
    span = { addTags: sinon.spy(), finish: sinon.spy() }
    global._ddtrace = {
      _tracer: {
        _config: { DD_APM_FLUSH_DEADLINE_MILLISECONDS: 25 },
        _processor: { killAll },
        scope: () => ({ active: () => span }),
      },
    }
    context = { getRemainingTimeInMillis: () => 100 }
  })

  afterEach(() => {
    clock.restore()
    global._ddtrace = originalTracer
  })

  it('preserves callback arity, receiver, arguments, and the raw return value', () => {
    const receiver = {}
    const event = {}
    const callbackReceiver = {}
    const callback = sinon.stub().returns('callback result')
    let complete
    const handler = withTimeoutMonitor(function (actualEvent, actualContext, cb) {
      assert.strictEqual(this, receiver)
      assert.strictEqual(actualEvent, event)
      assert.strictEqual(actualContext, context)
      complete = cb
      return 'incidental return'
    })

    assert.strictEqual(handler.length, 3)
    assert.strictEqual(handler.call(receiver, event, context, callback), 'incidental return')
    clock.tick(74)
    assert.strictEqual(killAll.callCount, 0)
    clock.tick(1)
    assert.strictEqual(killAll.callCount, 1, 'pending callback must remain monitored')
    assert.strictEqual(span.addTags.firstCall.args[0]['error.type'], 'Impending Timeout')
    assert.strictEqual(complete.call(callbackReceiver, null, 'done'), 'callback result')
    assert.strictEqual(callback.firstCall.thisValue, callbackReceiver)
    assert.deepStrictEqual(callback.firstCall.args, [null, 'done'])
  })

  for (const name of ['done', 'succeed', 'fail']) {
    for (const result of [undefined, new EventEmitter()]) {
      it(`keeps ${name} completion monitored after returning ${result ? 'an artifact' : 'undefined'}`, () => {
        const original = context[name] = sinon.spy()
        const handler = withTimeoutMonitor((_event, ctx) => result)
        assert.strictEqual(handler({}, context), result)
        const completion = context[name]
        clock.tick(75)
        assert.strictEqual(killAll.callCount, 1)
        completion.call(context, 'finished')
        assert.strictEqual(context[name], original, 'restore the context after completion')
        assert.strictEqual(original.firstCall.thisValue, context)
        assert.deepStrictEqual(original.firstCall.args, ['finished'])
      })
    }

    it(`cancels the timer when context.${name} completes`, () => {
      context[name] = sinon.spy()
      const handler = withTimeoutMonitor((_event, ctx) => { ctx[name]('done') })
      handler({}, context)
      clock.tick(100)
      assert.strictEqual(killAll.callCount, 0)
      assert.strictEqual(clock.countTimers(), 0)
    })
  }

  for (const error of [null, new Error('callback failure'), '']) {
    it(`cancels the timer on callback completion with ${String(error)}`, () => {
      const callback = sinon.spy()
      const handler = withTimeoutMonitor((_event, _context, cb) => { cb(error, 'done') })
      handler({}, context, callback)
      clock.tick(100)
      assert.strictEqual(killAll.callCount, 0)
      assert.deepStrictEqual(callback.firstCall.args, [error, 'done'])
    })
  }

  it('clears timers on sync return, sync throw, fulfillment, and rejection', async () => {
    const error = new Error('handler failure')
    const sync = withTimeoutMonitor(() => 'sync')
    const throwing = withTimeoutMonitor(() => { throw error })
    const resolving = withTimeoutMonitor(() => Promise.resolve('async'))
    const rejecting = withTimeoutMonitor(() => Promise.reject(error))
    assert.strictEqual(sync({}, context), 'sync')
    assert.throws(() => throwing({}, context), e => e === error)
    assert.strictEqual(await resolving({}, context), 'async')
    await assert.rejects(rejecting({}, context), e => e === error)
    clock.tick(100)
    assert.strictEqual(killAll.callCount, 0)
    assert.strictEqual(clock.countTimers(), 0)
  })

  for (const winner of ['callback', 'promise']) {
    it(`cleans up when the ${winner} wins a race and isolates late completion from a warm invocation`, async () => {
      let complete
      let resolvePromise
      const promise = new Promise(resolve => { resolvePromise = resolve })
      const handler = withTimeoutMonitor((_event, _context, cb) => {
        complete = cb
        return promise
      })
      const result = handler({}, context, () => {})
      if (winner === 'callback') complete(null, 'callback')
      else { resolvePromise('promise'); await result }
      assert.strictEqual(clock.countTimers(), 0)

      let nextComplete
      const next = withTimeoutMonitor((_event, _context, cb) => { nextComplete = cb })
      next({}, context, () => {})
      if (winner === 'callback') {
        resolvePromise('late promise')
        await result
      } else {
        complete(null, 'late callback')
      }
      assert.strictEqual(clock.countTimers(), 1, 'late completion must not cancel the next timer')
      clock.tick(75)
      assert.strictEqual(killAll.callCount, 1)
      nextComplete()
    })
  }

  it('preserves streaming metadata and treats a sync streaming return as completion', () => {
    const stream = {}
    const original = function (event, responseStream, ctx) {
      assert.strictEqual(responseStream, stream)
      assert.strictEqual(ctx, context)
    }
    original[HANDLER_STREAMING] = STREAM_RESPONSE
    const handler = withTimeoutMonitor(original)
    assert.strictEqual(handler[HANDLER_STREAMING], STREAM_RESPONSE)
    assert.strictEqual(handler.length, 3)
    assert.strictEqual(handler({}, stream, context), undefined)
    clock.tick(100)
    assert.strictEqual(killAll.callCount, 0)
  })

  it('does not require a context or an initialized tracer', () => {
    const handler = withTimeoutMonitor(() => 'value')
    assert.strictEqual(handler(), 'value')
    global._ddtrace = undefined
    assert.strictEqual(handler({}, context), 'value')
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('handles an already elapsed deadline without scheduling a negative timeout', () => {
    context.getRemainingTimeInMillis = () => 10
    const handler = withTimeoutMonitor(() => undefined)
    handler({}, context)
    clock.tick(0)
    assert.strictEqual(killAll.callCount, 1)
  })

  it('flushes unfinished spans even when no invocation span is active', () => {
    span = null
    const handler = withTimeoutMonitor(() => undefined)
    handler({}, context)
    clock.tick(75)
    assert.strictEqual(killAll.callCount, 1)
  })
})
