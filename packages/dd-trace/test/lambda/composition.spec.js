'use strict'

const assert = require('node:assert/strict')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const proxyquire = require('proxyquire').noCallThru()

const agent = require('../plugins/agent')
const { invocationChannel } = require('../../../datadog-instrumentations/src/aws-lambda')
const { HANDLER_STREAMING, STREAM_RESPONSE, promisifiedHandler } =
  require('../../../datadog-instrumentations/src/helpers/lambda-handler')
const { assertExactlyOneLambdaSpan } = require('./helpers')

describe('Lambda facade and hook composition', () => {
  let tracer
  let facade
  let clock
  let traces
  let context
  let oldEnv
  let hooks
  let exporter

  beforeEach(async () => {
    oldEnv = process.env
    process.env = {
      ...oldEnv,
      AWS_LAMBDA_FUNCTION_NAME: 'composition-test',
      LAMBDA_TASK_ROOT: '/var/task',
      DD_TRACE_ENABLED: 'true',
      DD_APM_FLUSH_DEADLINE_MILLISECONDS: '25',
    }
    delete process.env.DD_LAMBDA_HANDLER
    delete process.env.DD_TRACE_LAMBDA_WRAP_SHIM_HANDLERS
    tracer = await agent.load('aws-lambda', {}, { experimental: { exporter: 'agent' } })
    facade = require('../../../../lambda')
    traces = []
    // Capture every actual SpanProcessor export, not a matching agent request. This makes the
    // cardinality check deterministic and catches duplicates exported in separate trace chunks.
    exporter = sinon.stub(tracer._tracer._exporter, 'export').callsFake(trace => traces.push(trace))
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    context = { getRemainingTimeInMillis: () => 100, functionName: 'composition-test' }
    hooks = []
  })

  afterEach(async () => {
    clock.restore()
    exporter.restore()
    // Timeout flushing is terminal in AWS; the unit-test process deliberately reuses its tracer.
    tracer._tracer._processor._killAll = false
    process.env = oldEnv
    await agent.close()
  })

  function patch (branch, handler, datadog = h => h) {
    hooks.length = 0
    if (branch === 'layer') process.env.DD_LAMBDA_HANDLER = 'index.handler'
    else delete process.env.DD_LAMBDA_HANDLER
    proxyquire('../../src/lambda/runtime/patch', {
      '../../../../datadog-instrumentations/src/helpers/instrument': {
        addHook: (options, hook) => { if (!options.file) hooks.push(hook) },
      },
    })
    if (branch === 'layer') return hooks[0]({ handler }).handler
    return hooks[0]({ datadog }).datadog(handler)
  }

  for (const entry of ['facade', 'layer', 'npm']) {
    for (const owner of entry === 'facade' ? ['plugin'] : ['shim', 'plugin']) {
      it(`monitors the ${owner} span through ${entry}, flushing its unfinished child exactly once`, async () => {
        process.env.DD_TRACE_LAMBDA_WRAP_SHIM_HANDLERS = String(owner === 'plugin')
        let active
        let child
        const handler = () => {
          active = tracer.scope().active()
          child = tracer.startSpan('timeout.unfinished', { childOf: active })
          // Advance while inside the real invocation scope: fake timers do not create native
          // async resources to retain AsyncLocalStorage context themselves.
          clock.tick(75)
          return Promise.resolve('done')
        }
        Object.freeze(handler)
        const shim = h => tracer.wrap('aws.lambda', {}, promisifiedHandler(h))
        let wrapped
        if (entry === 'facade') wrapped = facade.wrap(handler)
        else if (entry === 'npm') wrapped = patch(entry, handler, owner === 'shim' ? shim : facade.wrap)
        else {
          wrapped = patch(entry, handler)
          if (owner === 'shim') wrapped = shim(wrapped)
        }

        assert.strictEqual(await wrapped({}, context), 'done')
        const span = assertExactlyOneLambdaSpan(traces)
        assert.strictEqual(span.span_id.toString(10), active.context().toSpanId())
        assert.strictEqual(span.meta['error.type'], 'Impending Timeout')
        assert.strictEqual(span.error, 1)
        assert.strictEqual(span.meta.component, owner === 'plugin' ? 'aws-lambda' : undefined)
        const children = traces.flat().filter(s => s.name === 'timeout.unfinished')
        assert.strictEqual(children.length, 1)
        assert.strictEqual(children[0].span_id.toString(10), child.context().toSpanId())
        assert.strictEqual(children[0].parent_id.toString(), span.span_id.toString())
        assert.strictEqual(clock.countTimers(), 0)
      })
    }
  }

  for (const branch of ['layer', 'npm']) {
    for (const gate of [false, true]) {
      for (const first of ['facade', 'hook']) {
        it(`is idempotent with ${first} first, ${branch} hook, and span gate ${gate}`, async () => {
          process.env.DD_TRACE_LAMBDA_WRAP_SHIM_HANDLERS = String(gate)
          const starts = []
          const subscriber = message => starts.push(message)
          invocationChannel.start.subscribe(subscriber)
          try {
            const handler = Object.freeze(() => 'done')
            const earlier = Object.freeze(first === 'facade' ? facade.wrap(handler) : patch(branch, handler))
            const wrapped = first === 'facade' ? patch(branch, earlier) : facade.wrap(earlier)
            assert.strictEqual(facade.wrap(handler), wrapped)
            assert.strictEqual(patch(branch, handler), wrapped)
            assert.strictEqual(facade.wrap(wrapped), wrapped)
            assert.strictEqual(patch(branch, wrapped), wrapped)
            assert.strictEqual(await wrapped({}, context), 'done')
            assertExactlyOneLambdaSpan(traces)
            assert.strictEqual(starts.length, 1)
            assert.strictEqual(clock.countTimers(), 0)
          } finally {
            invocationChannel.start.unsubscribe(subscriber)
          }
        })
      }
    }
  }

  for (const entry of ['facade', 'layer', 'npm']) {
    for (const shape of ['plain', 'rest', 'default']) {
      it(`clears the selected synchronous ${shape} completion through ${entry}`, async () => {
        process.env.DD_TRACE_LAMBDA_WRAP_SHIM_HANDLERS = 'true'
        let lateCallback
        const value = { ok: true }
        const handlers = {
          plain: (_event, _context) => value,
          rest: (...args) => { lateCallback = args[2]; return value },
          default: (_event, _context, callback = () => {}) => { lateCallback = callback; return value },
        }
        const handler = handlers[shape]
        const wrapped = entry === 'facade' ? facade.wrap(handler) : patch(entry, handler, facade.wrap)
        assert.strictEqual(await wrapped({}, context, () => {}), value)
        assertExactlyOneLambdaSpan(traces)
        // Watching the raw handler would retain this timer because a callback was supplied,
        // even though the completion adapter selected the synchronous return.
        assert.strictEqual(clock.countTimers(), 0)

        let complete
        const warm = facade.wrap((_event, _context, callback) => { complete = callback })
        const result = warm({}, context)
        assert.strictEqual(clock.countTimers(), 1)
        lateCallback?.(null, 'late')
        await Promise.resolve()
        assert.strictEqual(clock.countTimers(), 1, 'late completion must not clear the warm invocation timer')
        complete(null, 'warm')
        assert.strictEqual(await result, 'warm')
        assert.strictEqual(clock.countTimers(), 0)
        clock.tick(100)
        assert.strictEqual(traces.flat().filter(span => span.error).length, 0)
      })
    }

    it(`preserves safe streaming metadata through ${entry}`, async () => {
      process.env.DD_TRACE_LAMBDA_WRAP_SHIM_HANDLERS = 'true'
      const highWaterMark = Symbol.for('aws.lambda.runtime.handler.streaming.highWaterMark')
      const handler = (_event, _stream, _context) => Promise.resolve('streamed')
      handler[HANDLER_STREAMING] = STREAM_RESPONSE
      handler[highWaterMark] = 16384
      const wrapped = entry === 'facade' ? facade.wrap(handler) : patch(entry, handler, facade.wrap)
      assert.strictEqual(wrapped[HANDLER_STREAMING], STREAM_RESPONSE)
      assert.strictEqual(wrapped[highWaterMark], 16384)
      assert.strictEqual(wrapped.length, 3)
      assert.strictEqual(await wrapped({}, {}, context), 'streamed')
      assertExactlyOneLambdaSpan(traces)
      assert.strictEqual(clock.countTimers(), 0)
    })

    for (const shape of ['accessors', 'proxy']) {
      it(`does not execute ${shape} when composing ${entry}`, async () => {
        process.env.DD_TRACE_LAMBDA_WRAP_SHIM_HANDLERS = 'true'
        const unexpected = sinon.stub().throws(new Error('metadata access must not run'))
        let handler = () => 'safe'
        if (shape === 'proxy') {
          handler = new Proxy(handler, {
            get: unexpected,
            getOwnPropertyDescriptor: unexpected,
            getPrototypeOf: unexpected,
            ownKeys: unexpected,
          })
        } else {
          for (const name of ['length', 'apply', '_ddWrapped', HANDLER_STREAMING,
            Symbol.for('aws.lambda.runtime.handler.streaming.highWaterMark'),
            Symbol.for('dd-trace.lambda.wrapped')]) {
            Object.defineProperty(handler, name, { get: unexpected })
          }
        }
        const wrapped = entry === 'facade' ? facade.wrap(handler) : patch(entry, handler, facade.wrap)
        assert.strictEqual(await wrapped({}, context), 'safe')
        assert.strictEqual(unexpected.callCount, 0)
        assertExactlyOneLambdaSpan(traces)
        assert.strictEqual(clock.countTimers(), 0)
      })
    }
  }

  it('waits for a callback through the public facade despite an incidental sync return', async () => {
    let complete
    const wrapped = facade.wrap((_event, _context, callback) => {
      complete = callback
      return 'incidental'
    })
    const result = wrapped({}, context)
    await Promise.resolve()
    assert.strictEqual(traces.length, 0)
    assert.strictEqual(clock.countTimers(), 1)
    complete(null, 'callback result')
    assert.strictEqual(await result, 'callback result')
    assertExactlyOneLambdaSpan(traces)
    assert.strictEqual(clock.countTimers(), 0)
  })

  for (const name of ['done', 'succeed', 'fail']) {
    it(`waits for context.${name} through the public facade`, async () => {
      const wrapped = facade.wrap(() => undefined)
      const result = wrapped({}, context)
      await Promise.resolve()
      assert.strictEqual(traces.length, 0)
      assert.strictEqual(clock.countTimers(), 1)
      if (name === 'done') context.done(null, 'done')
      else if (name === 'succeed') context.succeed('done')
      else context.fail(new Error('failure'))
      if (name === 'fail') await assert.rejects(result, { message: 'failure' })
      else assert.strictEqual(await result, 'done')
      assertExactlyOneLambdaSpan(traces)
      assert.strictEqual(context.callbackWaitsForEmptyEventLoop, false)
      assert.strictEqual(clock.countTimers(), 0)
    })
  }

  for (const completion of ['throw', 'reject']) {
    it(`cleans up a streaming ${completion} through the public facade`, async () => {
      const error = new Error('stream failure')
      const handler = () => {
        if (completion === 'throw') throw error
        return Promise.reject(error)
      }
      handler[HANDLER_STREAMING] = STREAM_RESPONSE
      const wrapped = facade.wrap(handler)
      await assert.rejects(wrapped({}, {}, context), e => e === error)
      const span = assertExactlyOneLambdaSpan(traces)
      assert.strictEqual(span.meta['error.message'], 'stream failure')
      assert.strictEqual(clock.countTimers(), 0)
    })
  }

  it('forwards per-handler config and retains the explicit forceWrap escape hatch', async () => {
    const starts = []
    const subscriber = message => starts.push(message)
    invocationChannel.start.subscribe(subscriber)
    try {
      const config = { traceExtractor: () => ({}) }
      const handler = Object.freeze(() => 'done')
      const wrapped = Object.freeze(facade.wrap(handler, config))
      assert.strictEqual(facade.wrap(handler), wrapped)
      await wrapped({}, context)
      assert.strictEqual(starts[0].config, config)
      assertExactlyOneLambdaSpan(traces)
      const forcedConfig = { forceWrap: true }
      const forced = facade.wrap(handler, forcedConfig)
      assert.notStrictEqual(forced, wrapped)
      traces.length = 0
      await forced({}, context)
      assertExactlyOneLambdaSpan(traces)
      assert.strictEqual(starts.length, 2, 'forcing the raw handler must not stack its previous wrapper')
      assert.strictEqual(starts[1].config, forcedConfig)
    } finally {
      invocationChannel.start.unsubscribe(subscriber)
    }
  })

  it('rejects the old double-owner failure even when the two roots export separately', async () => {
    const wrapped = tracer.wrap('aws.lambda', {}, facade.wrap(() => 'done'))
    await wrapped({}, context)
    assert.strictEqual(traces.length, 2)
    assert.throws(() => assertExactlyOneLambdaSpan(traces), /exactly one aws.lambda span/)
  })

  it('preserves the streaming shape through both the monitor-only hook and the facade', async () => {
    const stream = {}
    const receiver = {}
    const handler = function (event, responseStream, ctx) {
      assert.strictEqual(this, receiver)
      assert.strictEqual(responseStream, stream)
      assert.strictEqual(ctx, context)
      return Promise.resolve('streamed')
    }
    handler[HANDLER_STREAMING] = STREAM_RESPONSE
    Object.freeze(handler)
    const monitored = patch('layer', handler)
    assert.strictEqual(monitored[HANDLER_STREAMING], STREAM_RESPONSE)
    const wrapped = facade.wrap(monitored)
    assert.strictEqual(wrapped[HANDLER_STREAMING], STREAM_RESPONSE)
    assert.strictEqual(await wrapped.call(receiver, {}, stream, context), 'streamed')
    assertExactlyOneLambdaSpan(traces)
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('keeps the invocation a root rather than adopting stale ambient scope', async () => {
    const stale = tracer.startSpan('previous-invocation')
    const wrapped = facade.wrap(() => 'done')
    await tracer.scope().activate(stale, () => wrapped({}, context))
    const span = assertExactlyOneLambdaSpan(traces)
    assert.strictEqual(span.parent_id.toString(10), '0')
    assert.notStrictEqual(span.trace_id.toString(10), stale.context().toTraceId())
    stale.finish()
  })
})
