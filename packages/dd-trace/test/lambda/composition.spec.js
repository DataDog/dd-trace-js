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
    delete process.env.DD_LAMBDA_HANDLER_COMPLETION
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

  for (const mode of ['return', 'callback']) {
    it(`keeps response streaming arguments and metadata in ${mode} mode`, async () => {
      const stream = {}
      const handler = (_event, responseStream, ctx) => {
        assert.strictEqual(responseStream, stream)
        assert.strictEqual(ctx, context)
        return Promise.resolve('stream result')
      }
      handler[HANDLER_STREAMING] = STREAM_RESPONSE
      const wrapped = facade.wrap(handler, { handlerCompletion: mode })
      assert.strictEqual(wrapped[HANDLER_STREAMING], STREAM_RESPONSE)
      assert.strictEqual(await wrapped({}, stream, context), 'stream result')
      assertExactlyOneLambdaSpan(traces)
      assert.strictEqual(clock.countTimers(), 0)
    })
  }

  describe('explicit callback completion', () => {
    for (const entry of ['facade', 'layer', 'npm']) {
      for (const shape of ['rest', 'default']) {
        for (const failure of [false, true]) {
          it(`waits for a ${shape} callback through ${entry} with failure ${failure}`, async () => {
            process.env.DD_LAMBDA_HANDLER_COMPLETION = 'CALLBACK'
            process.env.DD_TRACE_LAMBDA_WRAP_SHIM_HANDLERS = 'true'
            let complete
            let active
            let child
            const capture = callback => {
              complete = callback
              active = tracer.scope().active()
              child = tracer.startSpan('callback.child', { childOf: active })
              return { incidental: true }
            }
            const handler = shape === 'rest'
              ? (...args) => capture(args[2])
              : (_event, _context, callback = () => {}) => capture(callback)
            const wrapped = entry === 'facade' ? facade.wrap(handler) : patch(entry, handler, facade.wrap)
            const error = new Error('callback completion failure')
            let settled = false
            const result = wrapped({}, context)
            const observed = result.then(value => {
              settled = true
              assert.strictEqual(value, 'done')
            }, caught => {
              settled = true
              assert.strictEqual(caught, error)
            })
            await clock.tickAsync(0)
            assert.strictEqual(settled, false)
            assert.strictEqual(traces.length, 0)
            assert.strictEqual(clock.countTimers(), 1)
            child.finish()
            complete(failure ? error : null, 'done')
            complete(new Error('ignored duplicate'))
            await observed
            const span = assertExactlyOneLambdaSpan(traces)
            assert.strictEqual(span.span_id.toString(10), active.context().toSpanId())
            assert.strictEqual(span.error, failure ? 1 : 0)
            const exportedChild = traces.flat().find(span => span.name === 'callback.child')
            assert.strictEqual(exportedChild.parent_id.toString(), span.span_id.toString())
            assert.strictEqual(clock.countTimers(), 0)
            clock.tick(100)
            assertExactlyOneLambdaSpan(traces)
            assert.notStrictEqual(span.meta['error.type'], 'Impending Timeout')
          })
        }
      }
    }

    it('lets a per-handler callback option override return mode and keeps the first wrapper policy', async () => {
      process.env.DD_LAMBDA_HANDLER_COMPLETION = 'return'
      let complete
      const handler = (...args) => { complete = args[2]; return 'incidental' }
      const wrapped = facade.wrap(handler, { handlerCompletion: 'callback' })
      assert.strictEqual(facade.wrap(handler, { handlerCompletion: 'return' }), wrapped)
      let settled = false
      const observed = wrapped({}, context).then(value => { settled = true; return value })
      await clock.tickAsync(0)
      assert.strictEqual(settled, false)
      complete(null, 'callback result')
      assert.strictEqual(await observed, 'callback result')
      assertExactlyOneLambdaSpan(traces)
      assert.strictEqual(clock.countTimers(), 0)
    })

    for (const mode of ['auto', 'return']) {
      it(`lets per-handler ${mode} override callback mode`, async () => {
        process.env.DD_LAMBDA_HANDLER_COMPLETION = 'callback'
        const wrapped = facade.wrap(() => 'return result', { handlerCompletion: mode })
        let settled = false
        const observed = wrapped({}, context).then(value => { settled = true; return value })
        await clock.tickAsync(0)
        assert.strictEqual(settled, true)
        assert.strictEqual(await observed, 'return result')
        assertExactlyOneLambdaSpan(traces)
        assert.strictEqual(clock.countTimers(), 0)
      })
    }

    it('publishes completion with the Lambda plugin disabled', async () => {
      tracer.use('aws-lambda', { enabled: false })
      const ended = sinon.spy()
      invocationChannel.asyncEnd.subscribe(ended)
      try {
        let complete
        const wrapped = facade.wrap((...args) => {
          complete = args[2]
          return 'incidental'
        }, { handlerCompletion: 'callback' })
        const result = wrapped({}, context)
        await clock.tickAsync(0)
        assert.strictEqual(ended.callCount, 0)
        complete(null, 'done')
        assert.strictEqual(await result, 'done')
        assert.strictEqual(ended.callCount, 1)
        assert.strictEqual(traces.length, 0)
        assert.strictEqual(clock.countTimers(), 0)
      } finally {
        invocationChannel.asyncEnd.unsubscribe(ended)
      }
    })

    it('keeps timeout monitoring until the callback completes', async () => {
      let complete
      const wrapped = facade.wrap((...args) => {
        complete = args[2]
        tracer.startSpan('callback.unfinished', { childOf: tracer.scope().active() })
        clock.tick(75)
        return 'incidental'
      }, { handlerCompletion: 'callback' })
      let settled = false
      const observed = wrapped({}, context).then(value => { settled = true; return value })
      await clock.tickAsync(0)
      assert.strictEqual(settled, false)
      const span = assertExactlyOneLambdaSpan(traces)
      assert.strictEqual(span.meta['error.type'], 'Impending Timeout')
      const child = traces.flat().find(span => span.name === 'callback.unfinished')
      assert.strictEqual(child.parent_id.toString(), span.span_id.toString())
      complete(null, 'late result')
      assert.strictEqual(await observed, 'late result')
      assertExactlyOneLambdaSpan(traces)
      assert.strictEqual(clock.countTimers(), 0)
    })

    for (const entry of ['layer', 'npm']) {
      it(`leaves synchronous returns with the ${entry} gate off`, async () => {
        process.env.DD_LAMBDA_HANDLER_COMPLETION = 'callback'
        const shim = h => tracer.wrap('aws.lambda', {}, promisifiedHandler(h))
        let wrapped = patch(entry, () => 'legacy result', shim)
        if (entry === 'layer') wrapped = shim(wrapped)
        assert.strictEqual(await wrapped({}, context), 'legacy result')
        const span = assertExactlyOneLambdaSpan(traces)
        assert.strictEqual(span.meta.component, undefined)
        assert.strictEqual(clock.countTimers(), 0)
      })
    }
  })

  describe('explicit return completion', () => {
    for (const entry of ['facade', 'layer', 'npm']) {
      for (const outcome of ['undefined', 'throw', 'reject', 'promise']) {
        it(`finishes ${outcome} through ${entry} without a stale timeout`, async () => {
          process.env.DD_LAMBDA_HANDLER_COMPLETION = 'return'
          process.env.DD_TRACE_LAMBDA_WRAP_SHIM_HANDLERS = 'true'
          const error = new Error('return completion failure')
          const receiver = {}
          const event = {}
          let active
          const handler = function (input, ctx) {
            assert.strictEqual(this, receiver)
            assert.strictEqual(input, event)
            assert.strictEqual(ctx, context)
            active = tracer.scope().active()
            const child = tracer.startSpan('return.child', { childOf: active })
            child.finish()
            if (outcome === 'throw') throw error
            if (outcome === 'reject') return Promise.reject(error)
            if (outcome === 'promise') return Promise.resolve('done')
          }
          const wrapped = entry === 'facade' ? facade.wrap(handler) : patch(entry, handler, facade.wrap)
          let settled = false
          const result = wrapped.call(receiver, event, context, () => {})
          const observed = result.then(value => {
            settled = true
            return value
          }, failure => {
            settled = true
            assert.strictEqual(failure, error)
          })
          await clock.tickAsync(0)
          assert.strictEqual(settled, true, 'the returned Promise must settle without callback/context completion')
          assert.strictEqual(await observed, outcome === 'promise' ? 'done' : undefined)
          const span = assertExactlyOneLambdaSpan(traces)
          assert.strictEqual(span.span_id.toString(10), active.context().toSpanId())
          assert.strictEqual(span.error, outcome === 'throw' || outcome === 'reject' ? 1 : 0)
          const child = traces.flat().find(span => span.name === 'return.child')
          assert.strictEqual(child.parent_id.toString(), span.span_id.toString())
          assert.strictEqual(clock.countTimers(), 0)
          clock.tick(100)
          assertExactlyOneLambdaSpan(traces)
          assert.notStrictEqual(span.meta['error.type'], 'Impending Timeout')
        })
      }
    }

    it('accepts a per-handler option and leaves context completion methods untouched', async () => {
      const original = { ...context, done: () => {}, succeed: () => {}, fail: () => {} }
      Object.assign(context, original)
      const wrapped = facade.wrap(() => undefined, { handlerCompletion: 'return' })
      let settled = false
      const observed = wrapped({}, context).then(() => { settled = true })
      await clock.tickAsync(0)
      assert.strictEqual(settled, true)
      await observed
      assert.deepStrictEqual(context, original)
      assertExactlyOneLambdaSpan(traces)
      assert.strictEqual(clock.countTimers(), 0)
    })

    it('lets a per-handler auto option preserve delayed context completion over the environment', async () => {
      process.env.DD_LAMBDA_HANDLER_COMPLETION = 'return'
      const wrapped = facade.wrap(() => undefined, { handlerCompletion: 'auto' })
      let settled = false
      const observed = wrapped({}, context).then(value => { settled = true; return value })
      await clock.tickAsync(0)
      assert.strictEqual(settled, false)
      assert.strictEqual(clock.countTimers(), 1)
      context.succeed('context result')
      assert.strictEqual(await observed, 'context result')
      assertExactlyOneLambdaSpan(traces)
      assert.strictEqual(clock.countTimers(), 0)
    })

    it('selects completion when constructing the first wrapper', async () => {
      process.env.DD_LAMBDA_HANDLER_COMPLETION = 'RETURN'
      const handler = () => undefined
      const wrapped = facade.wrap(handler)
      delete process.env.DD_LAMBDA_HANDLER_COMPLETION
      assert.strictEqual(facade.wrap(handler, { handlerCompletion: 'auto' }), wrapped)
      let settled = false
      const observed = wrapped({}, context).then(() => { settled = true })
      await clock.tickAsync(0)
      assert.strictEqual(settled, true)
      await observed
      assertExactlyOneLambdaSpan(traces)
      assert.strictEqual(clock.countTimers(), 0)
    })

    it('publishes completion without creating spans when the Lambda plugin is disabled', async () => {
      tracer.use('aws-lambda', { enabled: false })
      const started = sinon.spy()
      invocationChannel.start.subscribe(started)
      try {
        const wrapped = facade.wrap(() => undefined, { handlerCompletion: 'return' })
        let settled = false
        const observed = wrapped({}, context).then(() => { settled = true })
        await clock.tickAsync(0)
        assert.strictEqual(settled, true)
        await observed
        assert.strictEqual(started.callCount, 1)
        assert.strictEqual(traces.length, 0)
        assert.strictEqual(clock.countTimers(), 0)
      } finally {
        invocationChannel.start.unsubscribe(started)
      }
    })

    it('keeps timeout monitoring until a returned Promise completes', async () => {
      let complete
      const wrapped = facade.wrap(() => {
        const child = tracer.startSpan('return.unfinished', { childOf: tracer.scope().active() })
        assert.ok(child)
        clock.tick(75)
        return new Promise(resolve => { complete = resolve })
      }, { handlerCompletion: 'return' })
      const result = wrapped({}, context)
      const span = assertExactlyOneLambdaSpan(traces)
      assert.strictEqual(span.meta['error.type'], 'Impending Timeout')
      const child = traces.flat().find(span => span.name === 'return.unfinished')
      assert.strictEqual(child.parent_id.toString(), span.span_id.toString())
      complete('late result')
      assert.strictEqual(await result, 'late result')
      assertExactlyOneLambdaSpan(traces)
      assert.strictEqual(clock.countTimers(), 0)
    })

    for (const entry of ['layer', 'npm']) {
      it(`leaves legacy context completion with the ${entry} gate off`, async () => {
        process.env.DD_LAMBDA_HANDLER_COMPLETION = 'return'
        let complete
        const handler = (_event, ctx) => { complete = ctx.succeed }
        const shim = h => tracer.wrap('aws.lambda', {}, promisifiedHandler(h))
        let wrapped = patch(entry, handler, shim)
        if (entry === 'layer') wrapped = shim(wrapped)
        const result = wrapped({}, context)
        await clock.tickAsync(0)
        assert.strictEqual(traces.length, 0)
        complete('legacy result')
        assert.strictEqual(await result, 'legacy result')
        const span = assertExactlyOneLambdaSpan(traces)
        assert.strictEqual(span.meta.component, undefined)
        assert.strictEqual(clock.countTimers(), 0)
      })
    }
  })

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
    for (const streaming of [false, true]) {
      it(`avoids reading completion accessors through ${entry} with streaming ${streaming}`, async () => {
        process.env.DD_TRACE_LAMBDA_WRAP_SHIM_HANDLERS = 'true'
        const unexpected = sinon.stub().throws(new Error('completion accessors must not run'))
        // The completion adapter can install its own methods; the monitor must not read or wrap
        // the original context methods before that adapter selects invocation completion.
        for (const name of ['done', 'succeed', 'fail']) {
          Object.defineProperty(context, name, { get: unexpected, set () {} })
        }
        const handler = streaming
          ? (_event, _stream, _context) => Promise.resolve('done')
          : (_event, _context, callback) => callback(null, 'done')
        if (streaming) handler[HANDLER_STREAMING] = STREAM_RESPONSE
        const wrapped = entry === 'facade' ? facade.wrap(handler) : patch(entry, handler, facade.wrap)
        const args = streaming ? [{}, {}, context] : [{}, context]
        assert.strictEqual(await wrapped(...args), 'done')
        assert.strictEqual(unexpected.callCount, 0)
        assertExactlyOneLambdaSpan(traces)
        assert.strictEqual(clock.countTimers(), 0)
      })
    }

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

  it('retains legacy context completion in the third argument through the facade', async () => {
    let complete
    const wrapped = facade.wrap((_event, _placeholder, context) => { complete = context.succeed })
    const result = wrapped({}, {}, context)
    await Promise.resolve()
    assert.strictEqual(traces.length, 0)
    assert.strictEqual(clock.countTimers(), 1)
    complete('done')
    assert.strictEqual(await result, 'done')
    assertExactlyOneLambdaSpan(traces)
    assert.strictEqual(clock.countTimers(), 0)
  })

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
