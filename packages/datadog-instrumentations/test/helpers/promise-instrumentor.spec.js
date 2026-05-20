'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')

const { channel } = require('../../src/helpers/instrument')
const { createPromiseInstrumentor } = require('../../src/helpers/promise-instrumentor')

// One unique prefix per describe block; channels are process-wide singletons and a stray
// subscriber from another suite would otherwise flip `hasSubscribers` and skew the bypass
// tests.
let prefixCounter = 0
function nextPrefix () {
  return `test:promise-instrumentor:${process.pid}:${++prefixCounter}`
}

describe('helpers/promise-instrumentor', () => {
  describe('bypass', () => {
    const prefix = nextPrefix()
    const instrument = createPromiseInstrumentor(prefix)

    it('should call through unchanged when there are no subscribers', async () => {
      const calls = []
      const wrapped = instrument(() => assert.fail('buildContext must not run without subscribers'))(
        function (...args) {
          calls.push({ thisArg: this, args })
          return Promise.resolve('ok')
        }
      )

      const ctx = { tag: 'caller-this' }
      const result = await wrapped.call(ctx, 1, 2)

      assert.strictEqual(result, 'ok')
      assert.strictEqual(calls.length, 1)
      assert.strictEqual(calls[0].thisArg, ctx)
      assert.deepStrictEqual(calls[0].args, [1, 2])
    })

    it('should call through unchanged when buildContext returns undefined', async () => {
      const startCh = channel(prefix + ':start')
      const events = []
      const handler = () => { events.push('start') }
      startCh.subscribe(handler)
      try {
        const wrapped = instrument(() => undefined)(function (...args) {
          return Promise.resolve(args.length)
        })

        const result = await wrapped('a', 'b', 'c')

        assert.strictEqual(result, 3)
        assert.deepStrictEqual(events, [])
      } finally {
        startCh.unsubscribe(handler)
      }
    })
  })

  describe('resolution', () => {
    const prefix = nextPrefix()
    const startCh = channel(prefix + ':start')
    const finishCh = channel(prefix + ':finish')
    const errorCh = channel(prefix + ':error')

    let events
    const startHandler = ctx => events.push({ type: 'start', ctx })
    const finishHandler = ctx => events.push({ type: 'finish', ctx })
    const errorHandler = ctx => events.push({ type: 'error', ctx })

    beforeEach(() => {
      events = []
      startCh.subscribe(startHandler)
      finishCh.subscribe(finishHandler)
      errorCh.subscribe(errorHandler)
    })

    afterEach(() => {
      startCh.unsubscribe(startHandler)
      finishCh.unsubscribe(finishHandler)
      errorCh.unsubscribe(errorHandler)
    })

    it('should publish start then finish without capturing the result by default', async () => {
      const instrument = createPromiseInstrumentor(prefix)
      const wrapped = instrument((_, args) => ({ args: [...args] }))(value => Promise.resolve(value))

      const resolved = await wrapped('payload')

      assert.strictEqual(resolved, 'payload')
      assert.strictEqual(events.length, 2)
      assert.strictEqual(events[0].type, 'start')
      assert.strictEqual(events[1].type, 'finish')
      assert.deepStrictEqual(events[0].ctx.args, ['payload'])
      assert.strictEqual('result' in events[1].ctx, false)
    })

    it('should attach ctx.result before publishing finish when captureResult is true', async () => {
      const instrument = createPromiseInstrumentor(prefix, { captureResult: true })
      const wrapped = instrument(() => ({}))(() => Promise.resolve({ address: '127.0.0.1' }))

      const resolved = await wrapped()

      assert.deepStrictEqual(resolved, { address: '127.0.0.1' })
      assert.strictEqual(events.length, 2)
      assert.deepStrictEqual(events[1].ctx.result, { address: '127.0.0.1' })
    })

    it('should publish error then finish and rethrow when the promise rejects', async () => {
      const instrument = createPromiseInstrumentor(prefix, { captureResult: true })
      const failure = new Error('boom')
      const wrapped = instrument(() => ({}))(() => Promise.reject(failure))

      await assert.rejects(wrapped(), error => error === failure)

      assert.deepStrictEqual(events.map(event => event.type), ['start', 'error', 'finish'])
      assert.strictEqual(events[1].ctx.error, failure)
      // `ctx.result` must not leak the rejection reason.
      assert.strictEqual('result' in events[2].ctx, false)
    })

    it('should publish error and rethrow when the underlying call throws synchronously', () => {
      const instrument = createPromiseInstrumentor(prefix)
      const failure = new TypeError('sync boom')
      const wrapped = instrument(() => ({}))(() => { throw failure })

      assert.throws(() => wrapped(), error => error === failure)

      assert.deepStrictEqual(events.map(event => event.type), ['start', 'error'])
      assert.strictEqual(events[1].ctx.error, failure)
    })
  })
})
