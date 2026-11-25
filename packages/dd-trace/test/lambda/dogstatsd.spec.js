'use strict'

const assert = require('node:assert/strict')
const dgram = require('node:dgram')
const { EventEmitter } = require('node:events')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noCallThru()
const sinon = require('sinon')

const agent = require('../plugins/agent')
const { HANDLER_STREAMING, STREAM_RESPONSE } =
  require('../../../datadog-instrumentations/src/helpers/lambda-handler')

// Exercise the public client and its real aggregation/transport tracking through Lambda completion.
describe('Lambda public DogStatsD completion', () => {
  let oldEnv, tracer, facade, clock, createSocket, exporter, packets, callbacks, traces, context
  let onSend
  let invocation = 0

  beforeEach(async () => {
    oldEnv = process.env
    process.env = {
      ...oldEnv,
      AWS_LAMBDA_FUNCTION_NAME: `dogstatsd-completion-${++invocation}`,
      DD_TRACE_ENABLED: 'true',
    }
    delete process.env.DD_LAMBDA_HANDLER
    delete process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS
    delete process.env.DD_TRACE_DISABLED_PLUGINS
    packets = []
    callbacks = []
    createSocket = sinon.stub(dgram, 'createSocket').callsFake(() => {
      const socket = new EventEmitter()
      socket.unref = () => socket
      socket.send = (buffer, _offset, _length, _port, _address, done) => {
        packets.push(buffer.toString())
        onSend?.()
        if (done) callbacks.push(done)
      }
      return socket
    })
    tracer = await agent.load('aws-lambda', {}, {
      experimental: { exporter: 'agent' },
      dogstatsd: { hostname: '127.0.0.1', port: 8125 },
    })
    facade = require('../../src/lambda/facade')
    traces = []
    exporter = sinon.stub(tracer._tracer._exporter, 'export').callsFake(trace => traces.push(trace))
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    context = { functionName: 'dogstatsd-completion', getRemainingTimeInMillis: () => 5000 }
  })

  afterEach(async () => {
    clock.restore()
    exporter.restore()
    createSocket.restore()
    process.env = oldEnv
    await agent.close()
  })

  /** @param {Error} [error] Transport result. */
  function deliver (error) {
    for (const callback of callbacks.splice(0)) callback(error)
  }

  function waitForSend () {
    return new Promise(resolve => { onSend = resolve })
  }

  for (const method of ['distribution', 'increment', 'decrement', 'gauge', 'histogram']) {
    it(`drains ${method} before the invocation resolves without the interval`, async () => {
      const value = { ok: true }
      const handler = facade.wrap(() => {
        tracer.dogstatsd[method](`completion.${method}`, 2, { probe: 'lambda' })
        return value
      })
      const sent = waitForSend()
      let completed = false
      const result = handler({}, context).then(value => { completed = true; return value })
      await Promise.race([sent, result])
      await clock.tickAsync(0)
      assert.ok(packets.some(packet => packet.includes(`completion.${method}`)), 'send at completion')
      assert.strictEqual(completed, false, 'wait for the socket callback')
      const spans = traces.flat().filter(span => span.name === 'aws.lambda')
      assert.strictEqual(spans.length, 1, 'finish the invocation before waiting for metrics')
      deliver()
      assert.strictEqual(await result, value)
    })
  }

  for (const outcome of ['throw', 'reject', 'callback', 'callback-error', 'done', 'succeed', 'fail', 'stream']) {
    it(`drains after ${outcome} and preserves the selected outcome`, async () => {
      const failure = new Error('customer failure')
      const value = { ok: true }
      const handler = (event, ctx, callback) => {
        tracer.dogstatsd.distribution('completion.outcome', 1)
        switch (outcome) {
          case 'throw': throw failure
          case 'reject': return Promise.reject(failure)
          case 'callback': callback(null, value); return
          case 'callback-error': callback(failure); return
          case 'done': ctx.done(null, value); return
          case 'succeed': ctx.succeed(value); return
          case 'fail': ctx.fail(failure); return
          default: return Promise.resolve(value)
        }
      }
      let customer = handler
      if (outcome === 'stream') {
        customer = (event, stream, ctx) => {
          assert.strictEqual(stream, responseStream)
          assert.strictEqual(ctx, context)
          tracer.dogstatsd.distribution('completion.outcome', 1)
          return Promise.resolve(value)
        }
        customer[HANDLER_STREAMING] = STREAM_RESPONSE
      }
      const responseStream = {}
      let completed = false
      const args = outcome === 'stream' ? [{}, responseStream, context] : [{}, context]
      const sent = waitForSend()
      const wrapped = facade.wrap(customer)
      const result = wrapped(...args).then(
        value => { completed = true; return { value } },
        error => { completed = true; return { error } }
      )
      await sent
      await clock.tickAsync(0)
      assert.ok(packets.some(packet => packet.includes('completion.outcome:')))
      assert.strictEqual(completed, false)
      deliver()
      assert.deepStrictEqual(await result, ['throw', 'reject', 'callback-error', 'fail'].includes(outcome)
        ? { error: failure }
        : { value })
    })
  }

  it('joins sends started by an earlier explicit flush', async () => {
    const sent = waitForSend()
    let finished = false
    const handler = facade.wrap(() => {
      tracer.dogstatsd.distribution('completion.earlier', 1)
      tracer.dogstatsd.flush()
      return 'done'
    })
    const result = handler({}, context).then(value => { finished = true; return value })
    await sent
    await clock.tickAsync(0)
    assert.ok(packets.some(packet => packet.includes('completion.earlier:')))
    assert.strictEqual(finished, false)
    deliver()
    assert.strictEqual(await result, 'done')
  })

  it('bounds a stalled send and isolates late callbacks from the next invocation', async () => {
    const handler = facade.wrap(() => {
      tracer.dogstatsd.distribution('completion.deadline', 1)
      return 'done'
    })
    const sent = waitForSend()
    const first = handler({}, context)
    await sent
    await clock.tickAsync(0)
    const stale = callbacks.splice(0)
    let firstFinished = false
    first.then(() => { firstFinished = true })
    await clock.tickAsync(999)
    assert.strictEqual(firstFinished, false)
    await clock.tickAsync(1)
    assert.strictEqual(await first, 'done')
    let nextFinished = false
    const nextSent = waitForSend()
    const next = handler({}, context).then(value => { nextFinished = true; return value })
    await clock.tickAsync(0)
    await nextSent
    for (const callback of stale) callback()
    await clock.tickAsync(0)
    assert.strictEqual(nextFinished, false)
    deliver()
    assert.strictEqual(await next, 'done')
  })

  it('joins an interval-triggered send that is still pending', async () => {
    context.getRemainingTimeInMillis = () => 60000
    const sent = waitForSend()
    let finished = false
    const handler = facade.wrap(() => {
      tracer.dogstatsd.distribution('completion.interval', 1)
      clock.tick(10000)
      return 'done'
    })
    const result = handler({}, context).then(value => { finished = true; return value })
    await sent
    await clock.tickAsync(0)
    assert.strictEqual(finished, false)
    deliver()
    assert.strictEqual(await result, 'done')
  })

  for (const disabled of ['enhanced-metrics', 'tracing-plugin']) {
    it(`flushes public metrics with ${disabled} disabled`, async () => {
      if (disabled === 'tracing-plugin') tracer.use('aws-lambda', { enabled: false })
      const sent = waitForSend()
      const handler = facade.wrap(() => {
        tracer.dogstatsd.increment('completion.disabled', 1)
        return 'done'
      }, { enhancedMetrics: false })
      const result = handler({}, context)
      await sent
      deliver()
      assert.strictEqual(await result, 'done')
    })
  }

  for (const outcome of ['return', 'reject']) {
    it(`preserves the customer ${outcome} after a UDP send error`, async () => {
      const failure = new Error('customer failure')
      const sent = waitForSend()
      const handler = facade.wrap(() => {
        tracer.dogstatsd.distribution('completion.failure', 1)
        if (outcome === 'reject') throw failure
        return 'done'
      })
      const result = handler({}, context).then(value => ({ value }), error => ({ error }))
      await sent
      deliver(new Error('socket failure'))
      assert.deepStrictEqual(await result, outcome === 'reject' ? { error: failure } : { value: 'done' })
    })

    it(`preserves the customer ${outcome} if the public flush throws`, async () => {
      const failure = new Error('customer failure')
      const flush = sinon.stub(tracer.dogstatsd, 'flush').throws(new Error('flush failure'))
      try {
        const handler = facade.wrap(() => {
          if (outcome === 'reject') throw failure
          return 'done'
        })
        if (outcome === 'reject') await assert.rejects(handler({}, context), error => error === failure)
        else assert.strictEqual(await handler({}, context), 'done')
        sinon.assert.calledOnce(flush)
      } finally {
        flush.restore()
      }
    })
  }

  it('skips the disabled public metric client without allocating a timer', async () => {
    const NoopDogStatsDClient = require('../../src/noop/dogstatsd')
    Object.defineProperty(tracer, 'dogstatsd', { value: new NoopDogStatsDClient(), configurable: true })
    const handler = facade.wrap(() => 'done')
    assert.strictEqual(await handler({}, context), 'done')
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('does not initialize an unused lazy public client', async () => {
    const before = Object.getOwnPropertyDescriptor(tracer, 'dogstatsd')
    assert.strictEqual(typeof before.get, 'function')
    const handler = facade.wrap(() => 'done')
    assert.strictEqual(await handler({}, context), 'done')
    assert.deepStrictEqual(Object.getOwnPropertyDescriptor(tracer, 'dogstatsd'), before)
    sinon.assert.notCalled(createSocket)
    assert.strictEqual(clock.countTimers(), 0)
  })

  for (const file of ['dist/metrics/listener.js', 'metrics/listener.js']) {
    for (const rejected of [false, true]) {
      it(`drains the public client after the released shim's ${file} completion (reject=${rejected})`, async () => {
        const hooks = []
        proxyquire('../../src/lambda/runtime/patch', {
          '../../../../datadog-instrumentations/src/helpers/instrument': {
            addHook: (options, hook) => { if (options.file === file) hooks.push(hook) },
          },
        })
        const failure = new Error('shim completion failure')
        class MetricsListener {
          async onCompleteInvocation () {
            if (rejected) throw failure
            return this.result
          }
        }
        assert.strictEqual(hooks.length, 1)
        hooks[0]({ MetricsListener })
        const listener = new MetricsListener()
        listener.result = 'shim-complete'
        tracer.dogstatsd.distribution('completion.shim', 1)
        const sent = waitForSend()
        let completed = false
        const result = listener.onCompleteInvocation().then(
          value => { completed = true; return { value } },
          error => { completed = true; return { error } }
        )
        await sent
        await clock.tickAsync(0)
        assert.ok(packets.some(packet => packet.includes('completion.shim:')))
        assert.strictEqual(completed, false)
        deliver()
        assert.deepStrictEqual(await result, rejected ? { error: failure } : { value: 'shim-complete' })
      })
    }
  }
})
