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
    delete process.env.DD_LAMBDA_HANDLER_COMPLETION
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

  function wrap (entry, handler, mode) {
    process.env.DD_LAMBDA_HANDLER_COMPLETION = mode
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

  for (const mode of ['auto', 'callback']) {
    for (const entry of ['facade', 'layer', 'npm']) {
      for (const outcome of ['callback', 'succeed', 'done', 'fail', 'promise', 'reject', 'throw']) {
        it(`delivers ${outcome} through ${entry} with explicit ${mode} wrapping after finishing the span`, async () => {
          const failed = ['fail', 'reject', 'throw'].includes(outcome)
          const error = new Error('handler failure')
          const ric = runtime(() => {
            const span = assertExactlyOneLambdaSpan(traces)
            assert.strictEqual(span.error, failed ? 1 : 0)
            assert.strictEqual(clock.countTimers(), 0)
          })
          const originals = Object.getOwnPropertyDescriptors(ric.context)
          const receiver = {}
          const event = {}
          const identities = new WeakMap([[ric.context, 'original']])
          let complete
          const order = []
          const wrapped = wrap(entry, function (input, context, callback) {
            order.push('handler')
            assert.strictEqual(this, receiver)
            assert.strictEqual(input, event)
            assert.strictEqual(context, ric.context)
            assert.strictEqual(identities.get(context), 'original')
            context.customerValue = 'visible'
            const child = tracer.startSpan('runtime.child', { childOf: tracer.scope().active() })
            child.finish()
            if (outcome === 'throw') throw error
            if (outcome === 'reject') return Promise.reject(error)
            if (outcome === 'promise') return Promise.resolve('done')
            complete = () => {
              if (outcome === 'callback') return callback(null, 'done')
              if (outcome === 'done') return context.done(null, 'done')
              if (outcome === 'fail') return context.fail(error)
              return context.succeed('done')
            }
          }, mode)
          order.push('before')
          const result = ric.invoke(wrapped, event, receiver)
          order.push('after')
          const observed = failed ? assert.rejects(result, value => value === error) : result
          assert.deepStrictEqual(order, ['before', 'handler', 'after'])
          assert.strictEqual(ric.context.customerValue, 'visible')
          complete?.()
          await observed
          await clock.tickAsync(0)
          assert.strictEqual(ric.posts.length, 1)
          if (failed) assert.strictEqual(ric.posts[0].error, error)
          else assert.strictEqual(ric.posts[0].value, 'done')
          const span = assertExactlyOneLambdaSpan(traces)
          const child = traces.flat().find(span => span.name === 'runtime.child')
          assert.strictEqual(child.parent_id.toString(), span.span_id.toString())
          for (const name of ['done', 'succeed', 'fail']) {
            assert.deepStrictEqual(Object.getOwnPropertyDescriptor(ric.context, name), originals[name])
          }
          clock.tick(100)
          assertExactlyOneLambdaSpan(traces)
          assert.strictEqual(clock.countTimers(), 0)
        })
      }
    }

    for (const timeout of [false, true]) {
      it(`preserves event-loop waiting and timeout ${timeout} in ${mode} mode`, async () => {
        const ric = runtime(() => { assertExactlyOneLambdaSpan(traces) })
        ric.context.callbackWaitsForEmptyEventLoop = true
        let callback
        let active
        const wrapped = facade.wrap((_event, _context, done) => {
          callback = done
          active = tracer.scope().active()
          if (timeout) tracer.startSpan('runtime.unfinished', { childOf: tracer.scope().active() })
        }, { handlerCompletion: mode })
        const result = ric.invoke(wrapped)
        callback(null, 'done')
        await result
        await clock.tickAsync(0)
        assert.strictEqual(ric.posts.length, 0)
        assert.strictEqual(traces.length, 0)
        assert.strictEqual(clock.countTimers(), 1)
        if (timeout) {
          // Fake timers do not capture AsyncLocalStorage like Node's real timeout callback does.
          tracer.scope().activate(active, () => clock.tick(75))
          const span = assertExactlyOneLambdaSpan(traces)
          assert.strictEqual(span.meta['error.type'], 'Impending Timeout')
          const child = traces.flat().find(span => span.name === 'runtime.unfinished')
          assert.strictEqual(child.parent_id.toString(), span.span_id.toString())
        }
        globalThis[BEFORE_EXIT]()
        await clock.tickAsync(0)
        assert.strictEqual(ric.posts.length, 1)
        assert.strictEqual(ric.posts[0].value, 'done')
        assertExactlyOneLambdaSpan(traces)
        assert.strictEqual(clock.countTimers(), 0)
      })
    }
  }

  for (const synchronous of [false, true]) {
    for (const failure of [false, true]) {
      it(`forwards a callback once with synchronous ${synchronous} and failure ${failure}`, async () => {
        const error = new Error('callback failure')
        const ric = runtime(() => { assertExactlyOneLambdaSpan(traces) })
        const succeed = sinon.spy(ric.context, 'succeed')
        const fail = sinon.spy(ric.context, 'fail')
        const ended = sinon.spy()
        invocationChannel.asyncEnd.subscribe(ended)
        try {
          let complete
          const wrapped = facade.wrap((_event, _context, callback) => {
            complete = () => {
              callback(failure ? error : null, 'first')
              callback(new Error('ignored duplicate'))
            }
            if (synchronous) complete()
          })
          const result = ric.invoke(wrapped)
          const observed = failure ? assert.rejects(result, value => value === error) : result
          if (!synchronous) complete()
          await observed
          await clock.tickAsync(0)
          assert.strictEqual(ric.posts.length, 1)
          assert.strictEqual(ended.callCount, 1)
          // RIC's automatic Promise continuation must not invoke a second native completion method.
          assert.strictEqual(succeed.callCount, 0)
          assert.strictEqual(fail.callCount, 0)
          assertExactlyOneLambdaSpan(traces)
          assert.strictEqual(clock.countTimers(), 0)
        } finally {
          invocationChannel.asyncEnd.unsubscribe(ended)
        }
      })
    }
  }

  for (const shape of ['rest', 'default']) {
    it(`delivers a ${shape} callback despite an incidental return in callback mode`, async () => {
      const ric = runtime(() => { assertExactlyOneLambdaSpan(traces) })
      let complete
      const capture = callback => { complete = callback; return { incidental: true } }
      const handler = shape === 'rest'
        ? (...args) => capture(args[2])
        : (_event, _context, callback = () => {}) => capture(callback)
      const result = ric.invoke(facade.wrap(handler, { handlerCompletion: 'callback' }))
      await clock.tickAsync(0)
      assert.strictEqual(ric.posts.length, 0)
      assert.strictEqual(traces.length, 0)
      complete(null, 'callback result')
      assert.strictEqual(await result, 'callback result')
      await clock.tickAsync(0)
      assert.strictEqual(ric.posts[0].value, 'callback result')
      assertExactlyOneLambdaSpan(traces)
    })
  }

  for (const first of ['callback', 'promise']) {
    it(`preserves ${first} winning a callback/Promise race at the runtime boundary`, async () => {
      const ric = runtime()
      let callback
      let finishPromise
      const wrapped = facade.wrap((_event, _context, done) => {
        callback = done
        return new Promise(resolve => { finishPromise = resolve })
      })
      const result = ric.invoke(wrapped)
      if (first === 'callback') callback(null, 'callback')
      else finishPromise('promise')
      assert.strictEqual(await result, first)
      await clock.tickAsync(0)
      if (first === 'callback') finishPromise('late promise')
      else callback(null, 'late callback')
      await clock.tickAsync(0)
      assert.strictEqual(ric.posts.length, 1)
      assert.strictEqual(ric.posts[0].value, first)
      assertExactlyOneLambdaSpan(traces)
      assert.strictEqual(clock.countTimers(), 0)
    })
  }

  for (const mode of ['auto', 'callback']) {
    for (const method of ['callback', 'done', 'succeed', 'fail']) {
      it(`keeps ${method} completion before a throw at the runtime boundary in ${mode} mode`, async () => {
        const ric = runtime()
        const firstError = new Error('first completion')
        const wrapped = facade.wrap((_event, context, callback) => {
          if (method === 'callback') callback(null, 'first result')
          if (method === 'done') context.done(null, 'first result')
          if (method === 'succeed') context.succeed('first result')
          if (method === 'fail') context.fail(firstError)
          throw new Error('after completion')
        }, { handlerCompletion: mode })
        const result = ric.invoke(wrapped)
        if (method === 'fail') await assert.rejects(result, error => error === firstError)
        else assert.strictEqual(await result, 'first result')
        await clock.tickAsync(0)
        assert.strictEqual(ric.posts.length, 1)
        if (method === 'fail') assert.strictEqual(ric.posts[0].error, firstError)
        else assert.strictEqual(ric.posts[0].value, 'first result')
        assert.strictEqual(assertExactlyOneLambdaSpan(traces).error, method === 'fail' ? 1 : 0)
        assert.strictEqual(clock.countTimers(), 0)
      })
    }
  }

  for (const method of ['callback', 'done', 'succeed', 'fail']) {
    it(`preserves the ${method} receiver, arguments, and return value`, async () => {
      const receiver = {}
      const returned = {}
      const error = new Error('context failure')
      const values = method === 'succeed'
        ? ['done', 'extra']
        : method === 'fail' ? [error, 'extra'] : [null, 'done', 'extra']
      const ric = runtime()
      const native = method === 'callback' ? ric.callback : ric.context[method]
      const observedNative = function (...args) {
        assert.strictEqual(this, receiver)
        assert.deepStrictEqual(args, values)
        assertExactlyOneLambdaSpan(traces)
        Reflect.apply(native, this, args)
        return returned
      }
      if (method !== 'callback') ric.context[method] = observedNative
      const wrapped = facade.wrap((_event, context, callback) => {
        const complete = method === 'callback' ? callback : context[method]
        assert.strictEqual(Reflect.apply(complete, receiver, values), returned)
      })
      const outer = (event, context, callback) => wrapped(event, context,
        method === 'callback' ? observedNative : callback)
      const result = ric.invoke(outer)
      if (method === 'fail') await assert.rejects(result, value => value === error)
      else assert.strictEqual(await result, 'done')
      await clock.tickAsync(0)
      assert.strictEqual(ric.posts.length, 1)
      assertExactlyOneLambdaSpan(traces)
    })
  }

  it('leaves an outer wrapper in control of returned Promise transformations', async () => {
    const ric = runtime()
    const wrapped = facade.wrap((_event, context) => {
      assert.strictEqual(context, ric.context)
      return Promise.resolve('inner')
    })
    let finishOuter
    const outer = (event, context, callback) => wrapped(event, context, callback).then(value => {
      return new Promise(resolve => { finishOuter = () => resolve(value + ' transformed') })
    })
    const result = ric.invoke(outer)
    await clock.tickAsync(0)
    assert.strictEqual(ric.posts.length, 0)
    finishOuter()
    assert.strictEqual(await result, 'inner transformed')
    await clock.tickAsync(0)
    assert.strictEqual(ric.posts[0].value, 'inner transformed')
    assertExactlyOneLambdaSpan(traces)
  })

  describe('queued callbacks during completion selection', () => {
    for (const mode of ['auto', 'callback']) {
      for (const outcome of ['promise', 'reject', 'throw', 'then getter']) {
        for (const depth of [1, 2]) {
          for (const callbackFails of [false, true]) {
            it(`keeps ${outcome} selected with ${depth} microtasks and callback failure ${callbackFails} in ${mode}`,
              async () => {
                process.env.DD_LAMBDA_HANDLER_COMPLETION = mode
                const error = new Error('selected failure')
                const failed = outcome !== 'promise'
                const ric = runtime()
                let nativeCallbackCalls = 0
                const wrapped = facade.wrap((_event, _context, callback) => {
                  const complete = () => callback(callbackFails ? new Error('losing callback') : null, 'callback')
                  queueMicrotask(depth === 1 ? complete : () => queueMicrotask(complete))
                  if (outcome === 'throw') throw error
                  if (outcome === 'then getter') return { get then () { throw error } }
                  return failed ? Promise.reject(error) : Promise.resolve('promise')
                })
                const result = ric.invoke((event, context, callback) => wrapped(event, context, (...values) => {
                  nativeCallbackCalls++
                  return callback(...values)
                }))
                if (failed) await assert.rejects(result, failure => failure === error)
                else assert.strictEqual(await result, 'promise')
                await clock.tickAsync(0)

                assert.strictEqual(nativeCallbackCalls, 0)
                assert.strictEqual(ric.posts.length, 1)
                if (failed) assert.strictEqual(ric.posts[0].error, error)
                else assert.strictEqual(ric.posts[0].value, 'promise')
                const span = assertExactlyOneLambdaSpan(traces)
                assert.strictEqual(span.error, failed ? 1 : 0)
                assert.strictEqual(clock.countTimers(), 0)
              })
          }
        }
      }

      for (const callbackFails of [false, true]) {
        it(`forwards a synchronous callback immediately with failure ${callbackFails} in ${mode}`, async () => {
          const ric = runtime()
          const error = new Error('callback failure')
          const wrapped = facade.wrap((_event, _context, callback) => {
            callback(callbackFails ? error : null, 'callback')
            assert.strictEqual(ric.posts.length, 1)
            return Promise.resolve('losing promise')
          }, { handlerCompletion: mode })
          const result = ric.invoke(wrapped)
          if (callbackFails) await assert.rejects(result, failure => failure === error)
          else assert.strictEqual(await result, 'callback')
          await clock.tickAsync(0)

          assert.strictEqual(ric.posts.length, 1)
          if (callbackFails) assert.strictEqual(ric.posts[0].error, error)
          else assert.strictEqual(ric.posts[0].value, 'callback')
          assertExactlyOneLambdaSpan(traces)
          assert.strictEqual(clock.countTimers(), 0)
        })
      }

      for (const method of ['done', 'succeed', 'fail']) {
        it(`keeps a queued callback before duplicate context.${method} in ${mode}`, async () => {
          const ric = runtime()
          let rejectPromise
          const wrapped = facade.wrap((_event, context, callback) => {
            queueMicrotask(() => {
              callback(null, 'callback')
              if (method === 'done') context.done(null, 'duplicate')
              if (method === 'succeed') context.succeed('duplicate')
              if (method === 'fail') context.fail(new Error('duplicate'))
            })
            return new Promise((resolve, reject) => { rejectPromise = reject })
          }, { handlerCompletion: mode })
          const result = ric.invoke(wrapped)
          assert.strictEqual(await result, 'callback')
          rejectPromise(new Error('losing promise'))
          await clock.tickAsync(0)

          assert.deepStrictEqual(ric.posts, [{ error: null, value: 'callback' }])
          assertExactlyOneLambdaSpan(traces)
          assert.strictEqual(clock.countTimers(), 0)
        })
      }
    }
  })

  describe('late callbacks during outer post-processing', () => {
    for (const mode of ['auto', 'callback']) {
      for (const outcome of ['promise', 'reject', 'throw', 'thenable']) {
        for (const callbackFails of [false, true]) {
          it(`keeps ${outcome} selected in ${mode} mode with late callback failure ${callbackFails}`, async () => {
            const ric = runtime()
            const native = sinon.spy(ric.callback)
            const innerError = new Error('inner failure')
            const outerError = new Error('outer transformed failure')
            const failed = outcome === 'reject' || outcome === 'throw'
            let callback
            let finishOuter
            const wrapped = facade.wrap((_event, _context, done) => {
              callback = done
              if (outcome === 'throw') throw innerError
              if (outcome === 'reject') return Promise.reject(innerError)
              if (outcome === 'thenable') return { then: resolve => resolve('inner') }
              return Promise.resolve('inner')
            }, { handlerCompletion: mode })
            const result = ric.invoke((event, context) => wrapped(event, context, native).then(value => {
              assert.strictEqual(value, 'inner')
              return new Promise(resolve => { finishOuter = () => resolve(value + ' transformed') })
            }, error => {
              assert.strictEqual(error, innerError)
              return new Promise((resolve, reject) => { finishOuter = () => reject(outerError) })
            }))
            const observed = failed ? assert.rejects(result, error => error === outerError) : result
            await clock.tickAsync(0)
            assert.strictEqual(typeof finishOuter, 'function')
            assert.strictEqual(ric.posts.length, 0)
            const span = assertExactlyOneLambdaSpan(traces)
            assert.strictEqual(span.error, failed ? 1 : 0)
            callback(callbackFails ? new Error('late callback') : null, 'late callback')
            assert.strictEqual(native.callCount, 0, 'a losing callback must not reach the runtime')
            assert.strictEqual(ric.posts.length, 0)
            finishOuter()
            if (failed) await observed
            else assert.strictEqual(await observed, 'inner transformed')
            await clock.tickAsync(0)
            assert.strictEqual(ric.posts.length, 1)
            if (failed) assert.strictEqual(ric.posts[0].error, outerError)
            else assert.strictEqual(ric.posts[0].value, 'inner transformed')
            assertExactlyOneLambdaSpan(traces)
            assert.strictEqual(clock.countTimers(), 0)
          })
        }
      }

      for (const wait of [false, true]) {
        it(`preserves callback-first completion and event-loop wait ${wait} in ${mode} mode`, async () => {
          const ric = runtime()
          ric.context.callbackWaitsForEmptyEventLoop = wait
          let callback
          let rejectPromise
          let finishOuter
          const wrapped = facade.wrap((_event, _context, done) => {
            callback = done
            return new Promise((resolve, reject) => { rejectPromise = reject })
          }, { handlerCompletion: mode })
          const result = ric.invoke((...args) => wrapped(...args).then(value => {
            return new Promise(resolve => { finishOuter = () => resolve(value + ' transformed') })
          }))
          callback(null, 'callback')
          await clock.tickAsync(0)
          assert.strictEqual(typeof finishOuter, 'function')
          assert.strictEqual(ric.posts.length, wait ? 0 : 1)
          assert.strictEqual(traces.length, wait ? 0 : 1)
          assert.strictEqual(clock.countTimers(), wait ? 1 : 0)
          rejectPromise(new Error('losing returned Promise'))
          finishOuter()
          assert.strictEqual(await result, 'callback transformed')
          await clock.tickAsync(0)
          assert.strictEqual(ric.posts.length, wait ? 0 : 1)
          if (wait) {
            assert.strictEqual(traces.length, 0)
            assert.strictEqual(clock.countTimers(), 1)
            globalThis[BEFORE_EXIT]()
            await clock.tickAsync(0)
          }
          assert.strictEqual(ric.posts.length, 1)
          assert.strictEqual(ric.posts[0].value, 'callback')
          assertExactlyOneLambdaSpan(traces)
          assert.strictEqual(clock.countTimers(), 0)
        })
      }
    }

    for (const monitor of [false, true]) {
      it(`ignores losing callbacks with tracing disabled and timeout monitoring ${monitor}`, async () => {
        tracer.use('aws-lambda', { enabled: false })
        const ric = runtime()
        if (!monitor) ric.context.getRemainingTimeInMillis = () => NaN
        let callback
        let finishOuter
        const wrapped = facade.wrap((_event, _context, done) => {
          callback = done
          return Promise.resolve('inner')
        })
        const result = ric.invoke((...args) => wrapped(...args).then(value => {
          return new Promise(resolve => { finishOuter = () => resolve(value + ' transformed') })
        }))
        await clock.tickAsync(0)
        callback(null, 'late callback')
        assert.strictEqual(ric.posts.length, 0)
        finishOuter()
        assert.strictEqual(await result, 'inner transformed')
        await clock.tickAsync(0)
        assert.strictEqual(ric.posts.length, 1)
        assert.strictEqual(ric.posts[0].value, 'inner transformed')
        assert.strictEqual(traces.length, 0)
        assert.strictEqual(clock.countTimers(), 0)
      })
    }
  })

  it('does not overwrite a customer replacement when restoring context methods', async () => {
    const ric = runtime()
    let callback
    const wrapped = facade.wrap((_event, _context, done) => { callback = done })
    const result = ric.invoke(wrapped)
    const replacement = () => 'customer replacement'
    ric.context.succeed = replacement
    callback(null, 'done')
    await result
    await clock.tickAsync(0)
    assert.strictEqual(ric.context.succeed, replacement)
    assert.strictEqual(ric.posts.length, 1)
    assertExactlyOneLambdaSpan(traces)
  })

  it('finishes tracing before the runtime completes an idle handler', async () => {
    const ric = runtime(() => {
      assertExactlyOneLambdaSpan(traces)
      assert.strictEqual(clock.countTimers(), 0)
    })
    const originals = Object.getOwnPropertyDescriptors(ric.context)
    const settled = sinon.spy()
    ric.invoke(facade.wrap(() => undefined)).then(settled)
    assert.strictEqual(traces.length, 0)
    globalThis[BEFORE_EXIT]()
    await clock.tickAsync(0)
    assert.strictEqual(ric.posts.length, 1)
    assert.strictEqual(ric.posts[0].value, null)
    assert.strictEqual(settled.callCount, 0)
    assert.strictEqual(assertExactlyOneLambdaSpan(traces).error, 0)
    for (const name of ['done', 'succeed', 'fail']) {
      assert.deepStrictEqual(Object.getOwnPropertyDescriptor(ric.context, name), originals[name])
    }
  })

  it('delivers callbacks with the plugin disabled and publishes completion once', async () => {
    tracer.use('aws-lambda', { enabled: false })
    const ended = sinon.spy()
    invocationChannel.asyncEnd.subscribe(ended)
    try {
      const ric = runtime(() => { assert.strictEqual(ended.callCount, 1) })
      const wrapped = facade.wrap((_event, _context, callback) => { callback(null, 'done') })
      await ric.invoke(wrapped)
      await clock.tickAsync(0)
      assert.strictEqual(ric.posts.length, 1)
      assert.strictEqual(traces.length, 0)
      assert.strictEqual(ended.callCount, 1)
    } finally {
      invocationChannel.asyncEnd.unsubscribe(ended)
    }
  })
})
