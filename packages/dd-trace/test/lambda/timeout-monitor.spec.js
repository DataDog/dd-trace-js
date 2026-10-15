'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { datadog } = require('../../src/lambda/handler')

const HANDLER_STREAMING = Symbol.for('aws.lambda.runtime.handler.streaming')

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

  for (const protect of [Object.freeze, Object.seal, Object.preventExtensions]) {
    it(`monitors a ${protect.name} handler without modifying it`, () => {
      const original = protect((_event, _context, callback) => undefined)
      const descriptors = Object.getOwnPropertyDescriptors(original)
      const monitored = datadog(original)
      assert.strictEqual(monitored.length, 3)
      monitored({}, context, () => {})
      assert.strictEqual(clock.countTimers(), 1)
      clock.tick(75)
      assert.strictEqual(killAll.callCount, 1)
      assert.deepStrictEqual(span.addTags.firstCall.args, [{
        'error.message': 'Datadog detected an impending timeout',
        'error.type': 'Impending Timeout',
      }])
      assert.strictEqual(span.finish.callCount, 1)
      sinon.assert.callOrder(span.addTags, killAll, span.finish)
      assert.deepStrictEqual(Object.getOwnPropertyDescriptors(original), descriptors)
    })
  }

  it('preserves callback arity, receiver, arguments, and the raw return value', () => {
    const receiver = {}
    const event = {}
    const callbackReceiver = {}
    const callback = sinon.stub().returns('callback result')
    let complete
    const handler = datadog(function (actualEvent, actualContext, cb) {
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
    assert.strictEqual(complete.call(callbackReceiver, null, 'done'), 'callback result')
    assert.strictEqual(callback.firstCall.thisValue, callbackReceiver)
    assert.deepStrictEqual(callback.firstCall.args, [null, 'done'])
  })

  for (const name of ['done', 'succeed', 'fail']) {
    for (const result of [undefined, new EventEmitter()]) {
      it(`keeps ${name} completion monitored after returning ${result ? 'an artifact' : 'undefined'}`, () => {
        const original = context[name] = sinon.stub().returns('completion result')
        const handler = datadog((_event, ctx) => result)
        assert.strictEqual(handler({}, context), result)
        const completion = context[name]
        clock.tick(75)
        assert.strictEqual(killAll.callCount, 1)
        assert.strictEqual(completion.call(context, 'finished'), 'completion result')
        assert.strictEqual(context[name], original, 'restore the context after completion')
        assert.strictEqual(original.firstCall.thisValue, context)
        assert.deepStrictEqual(original.firstCall.args, ['finished'])
      })
    }

    it(`cancels the timer when context.${name} completes`, () => {
      const original = context[name] = sinon.spy()
      const handler = datadog((_event, ctx) => { ctx[name]('done') })
      handler({}, context)
      clock.tick(100)
      assert.strictEqual(killAll.callCount, 0)
      assert.strictEqual(clock.countTimers(), 0)
      assert.strictEqual(context[name], original)
    })
  }

  for (const error of [null, new Error('callback failure'), '', 0, false]) {
    it(`cancels the timer on callback completion with ${String(error)}`, () => {
      const callback = sinon.spy()
      let complete
      const handler = datadog((_event, _context, cb) => { complete = cb })
      handler({}, context, callback)
      assert.strictEqual(clock.countTimers(), 1)
      complete(error, 'done')
      clock.tick(100)
      assert.strictEqual(killAll.callCount, 0)
      assert.deepStrictEqual(callback.firstCall.args, [error, 'done'])
    })
  }

  for (const result of [
    { listen () {}, close () {} },
    { on () {}, emit () {} },
    new (class Socket {})(),
  ]) {
    it(`keeps a ${result.constructor.name} side-effect artifact monitored until context completion`, () => {
      context.done = sinon.spy()
      const handler = datadog(() => result)
      assert.strictEqual(handler({}, context), result)
      assert.strictEqual(clock.countTimers(), 1)
      context.done()
      clock.tick(100)
      assert.strictEqual(killAll.callCount, 0)
    })
  }

  for (const value of [null, false, 0, '', {}, Object.create(null)]) {
    it(`treats an ordinary ${value === null ? 'null' : typeof value} return as completion`, () => {
      const handler = datadog(() => value)
      assert.strictEqual(handler({}, context), value)
      assert.strictEqual(clock.countTimers(), 0)
    })
  }

  it('does not overwrite a context method replaced by the handler', () => {
    context.done = sinon.spy()
    const replacement = sinon.spy()
    const handler = datadog((_event, ctx) => {
      ctx.done = replacement
      return 'done'
    })
    handler({}, context)
    assert.strictEqual(context.done, replacement)
    assert.strictEqual(clock.countTimers(), 0)
  })

  for (const completion of ['return', 'throw', 'fulfill', 'reject']) {
    it(`clears the timer on ${completion}`, async () => {
      const error = new Error('handler failure')
      const handlers = {
        return: () => 'sync',
        throw: () => { throw error },
        fulfill: () => Promise.resolve('async'),
        reject: () => Promise.reject(error),
      }
      context.done = sinon.spy()
      const original = context.done
      const handler = datadog(handlers[completion])
      if (completion === 'throw') assert.throws(() => handler({}, context), e => e === error)
      else if (completion === 'reject') await assert.rejects(handler({}, context), e => e === error)
      else assert.strictEqual(await handler({}, context), completion === 'return' ? 'sync' : 'async')
      clock.tick(100)
      assert.strictEqual(killAll.callCount, 0)
      assert.strictEqual(clock.countTimers(), 0)
      assert.strictEqual(context.done, original)
    })
  }

  it('does not let an earlier invocation clear a later invocation timer', async () => {
    let resolveFirst
    let resolveSecond
    const firstHandler = datadog(() => new Promise(resolve => { resolveFirst = resolve }))
    const secondHandler = datadog(() => new Promise(resolve => { resolveSecond = resolve }))
    const first = firstHandler({}, context)
    const second = secondHandler({}, context)
    assert.strictEqual(clock.countTimers(), 2)
    resolveFirst('first')
    await first
    resolveSecond('second')
    await second
    clock.tick(100)
    assert.strictEqual(killAll.callCount, 0)
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('clears the timer when invoking a thenable throws', () => {
    const error = new Error('thenable failure')
    const handler = datadog(() => ({ then () { throw error } }))
    assert.throws(() => handler({}, context), e => e === error)
    assert.strictEqual(clock.countTimers(), 0)
  })

  for (const winner of ['callback', 'promise']) {
    it(`cleans up when the ${winner} wins a race and isolates late completion from a warm invocation`, async () => {
      let complete
      let resolvePromise
      const promise = new Promise(resolve => { resolvePromise = resolve })
      const handler = datadog((_event, _context, cb) => {
        complete = cb
        return promise
      })
      const result = handler({}, context, () => {})
      if (winner === 'callback') complete(null, 'callback')
      else { resolvePromise('promise'); await result }
      assert.strictEqual(clock.countTimers(), 0)

      let nextComplete
      const next = datadog((_event, _context, cb) => { nextComplete = cb })
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
    original[HANDLER_STREAMING] = 'response'
    const handler = datadog(original)
    assert.strictEqual(handler[HANDLER_STREAMING], 'response')
    assert.strictEqual(handler.length, 3)
    assert.strictEqual(handler({}, stream, context), undefined)
    clock.tick(100)
    assert.strictEqual(killAll.callCount, 0)
  })

  it('does not require a context or an initialized tracer', () => {
    const receiver = {}
    const handler = datadog(function () { return this })
    assert.strictEqual(handler.call(receiver), receiver)
    global._ddtrace = undefined
    assert.strictEqual(handler.call(receiver, {}, context), receiver)
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('handles an already elapsed deadline', () => {
    context.getRemainingTimeInMillis = () => 10
    const handler = datadog(() => undefined)
    handler({}, context)
    clock.tick(0)
    assert.strictEqual(killAll.callCount, 1)
  })

  for (const invalid of [undefined, NaN, Infinity]) {
    it(`does not arm a timer for a non-finite remaining time (${invalid})`, () => {
      context.getRemainingTimeInMillis = () => invalid
      const handler = datadog(() => 'result')
      assert.strictEqual(handler({}, context), 'result')
      assert.strictEqual(clock.countTimers(), 0)
    })
  }

  it('flushes unfinished spans even when no invocation span is active', () => {
    span = null
    const handler = datadog(() => undefined)
    handler({}, context)
    clock.tick(75)
    assert.strictEqual(killAll.callCount, 1)
  })
})
