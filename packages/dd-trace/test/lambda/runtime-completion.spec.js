'use strict'

const assert = require('node:assert/strict')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()

const agent = require('../plugins/agent')
const { invocationChannel } = require('../../../datadog-instrumentations/src/aws-lambda')
const { assertExactlyOneLambdaSpan } = require('./helpers')

const BEFORE_EXIT = Symbol.for('aws.lambda.beforeExit')

// Model the dispatch and first-completion contract of AWS RIC v3.3.0, including its shared context:
// https://github.com/aws/aws-lambda-nodejs-runtime-interface-client/blob/v3.3.0/src/Runtime.js#L53-L80
// https://github.com/aws/aws-lambda-nodejs-runtime-interface-client/blob/v3.3.0/src/CallbackContext.js
// Separate probes also run the unmodified AWS files; this fixture needs no runtime/network dependency.
function runtime (onPost = () => {}) {
  const posts = []
  let finished = false
  let wait = false
  const post = (error, value) => {
    onPost(error, value)
    posts.push({ error, value })
  }
  const done = (error, value) => {
    if (finished) return
    finished = true
    post(error, value)
  }
  const callback = (error, value) => {
    if (finished) return
    finished = true
    if (error == null && wait) {
      globalThis[BEFORE_EXIT] = () => setImmediate(() => post(error, value))
    } else {
      post(error, value)
    }
  }
  const context = {
    getRemainingTimeInMillis: () => 100,
    functionName: 'runtime-completion',
    get callbackWaitsForEmptyEventLoop () { return wait },
    set callbackWaitsForEmptyEventLoop (value) { wait = value },
    done,
    succeed: value => done(null, value),
    fail: error => done(error),
  }
  globalThis[BEFORE_EXIT] = () => done(null, null)
  return {
    posts,
    context,
    callback,
    invoke (handler, event = {}, receiver) {
      try {
        const result = Reflect.apply(handler, receiver, [event, context, callback])
        if (result && typeof result.then === 'function') {
          // Deliberately read context methods AFTER the customer wrapper runs, exactly as RIC does.
          result.then(context.succeed, context.fail).catch(context.fail)
        }
        return result
      } catch (error) {
        callback(error)
      }
    },
  }
}

describe('Lambda runtime completion handoff', () => {
  let tracer
  let facade
  let clock
  let traces
  let exporter
  let oldEnv
  let beforeExitDescriptor

  beforeEach(async () => {
    oldEnv = process.env
    process.env = {
      ...oldEnv,
      AWS_LAMBDA_FUNCTION_NAME: 'runtime-completion',
      LAMBDA_TASK_ROOT: '/var/task',
      DD_TRACE_ENABLED: 'true',
      DD_APM_FLUSH_DEADLINE_MILLISECONDS: '25',
    }
    delete process.env.DD_LAMBDA_HANDLER
    tracer = await agent.load('aws-lambda', {}, { experimental: { exporter: 'agent' } })
    facade = require('../../../../lambda')
    traces = []
    exporter = sinon.stub(tracer._tracer._exporter, 'export').callsFake(trace => traces.push(trace))
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate'] })
    beforeExitDescriptor = Object.getOwnPropertyDescriptor(globalThis, BEFORE_EXIT)
  })

  afterEach(async () => {
    clock.restore()
    exporter.restore()
    if (beforeExitDescriptor) Object.defineProperty(globalThis, BEFORE_EXIT, beforeExitDescriptor)
    else delete globalThis[BEFORE_EXIT]
    tracer._tracer._processor._killAll = false
    process.env = oldEnv
    await agent.close()
  })

  function wrap (entry, handler) {
    if (entry === 'facade') return facade.wrap(handler)
    const hooks = []
    if (entry === 'layer') process.env.DD_LAMBDA_HANDLER = 'index.handler'
    else delete process.env.DD_LAMBDA_HANDLER
    proxyquire('../../src/lambda/runtime/patch', {
      '../../../../datadog-instrumentations/src/helpers/instrument': {
        addHook: (options, hook) => { if (!options.file) hooks.push(hook) },
      },
    })
    return entry === 'layer'
      ? hooks[0]({ handler: facade.wrap(handler) }).handler
      : hooks[0]({ datadog: facade.wrap }).datadog(handler)
  }

  for (const entry of ['facade', 'layer', 'npm']) {
    for (const outcome of ['callback', 'succeed', 'done', 'fail', 'promise', 'reject', 'throw', 'value']) {
      it('delivers the shim ' + outcome + ' result through ' + entry, async () => {
        const failed = ['fail', 'reject', 'throw'].includes(outcome)
        const error = new Error('handler failure')
        const ric = runtime(() => {
          const span = assertExactlyOneLambdaSpan(traces)
          assert.strictEqual(span.error, failed ? 1 : 0)
          assert.strictEqual(clock.countTimers(), 0)
        })
        const originalSucceed = ric.context.succeed
        const event = {}
        let called = false
        // The value case needs arity < 3, matching the shim's existing heuristic.
        const handler = outcome === 'value'
          ? () => 'done'
          : (input, context, callback) => {
              assert.strictEqual(input, event)
              assert.strictEqual(context, ric.context)
              if (outcome === 'throw') throw error
              if (outcome === 'reject') return Promise.reject(error)
              if (outcome === 'promise') return Promise.resolve('done')
              if (outcome === 'done') context.done(null, 'done')
              if (outcome === 'succeed') context.succeed('done')
              if (outcome === 'fail') context.fail(error)
              if (outcome === 'callback') callback(null, 'done')
            }
        const wrapped = wrap(entry, Object.defineProperty((...args) => {
          called = true
          const child = tracer.startSpan('runtime.child', { childOf: tracer.scope().active() })
          child.finish()
          return handler(...args)
        }, 'length', { value: handler.length }))
        const result = ric.invoke(wrapped, event)
        assert.strictEqual(called, false, 'shim startup must yield before the adapter mutates context')
        assert.strictEqual(ric.context.succeed, originalSucceed)
        if (failed) await assert.rejects(result, e => e === error)
        else assert.strictEqual(await result, 'done')
        await clock.tickAsync(0)
        assert.strictEqual(called, true)
        assert.strictEqual(ric.posts.length, 1)
        if (failed) assert.strictEqual(ric.posts[0].error, error)
        else assert.strictEqual(ric.posts[0].value, 'done')
        const span = assertExactlyOneLambdaSpan(traces)
        const child = traces.flat().find(span => span.name === 'runtime.child')
        assert.strictEqual(child.parent_id.toString(), span.span_id.toString())
        assert.strictEqual(clock.countTimers(), 0)
      })
    }
  }

  it('delivers the final result of an asynchronous outer wrapper', async () => {
    const ric = runtime()
    const wrapped = facade.wrap(async () => 'inner')
    const result = ric.invoke(async (...args) => {
      const value = await wrapped(...args)
      await Promise.resolve()
      return value + ' outer'
    })
    assert.strictEqual(await result, 'inner outer')
    await clock.tickAsync(0)
    assert.deepStrictEqual(ric.posts, [{ error: null, value: 'inner outer' }])
    assertExactlyOneLambdaSpan(traces)
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('completes with the Lambda plugin disabled', async () => {
    tracer.use('aws-lambda', { enabled: false })
    const ended = sinon.spy()
    invocationChannel.asyncEnd.subscribe(ended)
    try {
      const ric = runtime()
      assert.strictEqual(await ric.invoke(facade.wrap(async () => 'done')), 'done')
      await clock.tickAsync(0)
      assert.deepStrictEqual(ric.posts, [{ error: null, value: 'done' }])
      assert.strictEqual(ended.callCount, 1)
      assert.strictEqual(traces.length, 0)
      assert.strictEqual(clock.countTimers(), 0)
    } finally {
      invocationChannel.asyncEnd.unsubscribe(ended)
    }
  })
})
