'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, before, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

// Channels the addHook wrapper feeds. The unit tests subscribe to each in turn
// to exercise the wrapper's slow paths without spinning up a real fastify server.
const errorChannel = dc.channel('apm:fastify:middleware:error')
const cookieParserReadCh = dc.channel('datadog:fastify-cookie:read:finish')
const callbackFinishCh = dc.channel('datadog:fastify:callback:execute')
const queryParamsReadCh = dc.channel('datadog:fastify:query-params:finish')
const bodyParserReadCh = dc.channel('datadog:fastify:body-parser:finish')
const pathParamsReadCh = dc.channel('datadog:fastify:path-params:finish')

describe('fastify instrumentation (unit)', () => {
  let factoryForFastify3

  before(() => {
    const realInstrument = require('../src/helpers/instrument')
    const addHookSpy = sinon.spy()
    proxyquire('../src/fastify', {
      './helpers/instrument': { ...realInstrument, addHook: addHookSpy },
    })

    // The instrumentation file registers four hooks; the first one targets
    // `fastify` `>=3` and exposes `fastifyWithTrace` once invoked. We capture
    // that factory and re-use it across every test.
    const call = addHookSpy.getCalls().find(c => {
      const target = c.args[0]
      return target.name === 'fastify' && target.versions?.[0] === '>=3' && !target.file
    })
    factoryForFastify3 = call.args[1]
  })

  /**
   * Build a fake fastify instance, run the dd-trace factory against it, and
   * return the user-facing `addHook` (already swapped by `wrapAddHook`) plus
   * the list of hooks the wrap registers on the fake app.
   */
  function buildWrappedAddHook () {
    const registered = []
    const fakeAddHook = sinon.stub().callsFake((name, fn) => {
      registered.push({ name, fn })
    })
    const fakeApp = { addHook: fakeAddHook }
    const fakeFastify = sinon.stub().returns(fakeApp)

    const wrappedCtor = factoryForFastify3(fakeFastify)
    wrappedCtor()

    // Split out the hooks registered by `wrapFastify`; tests that exercise
    // the user-facing `addHook` work against `registered`, while tests for the
    // internal `preParsing` / `preValidation` pair drive `internal` directly.
    const internal = registered.splice(0)
    const internalByName = name => internal.filter(entry => entry.name === name).map(entry => entry.fn)

    return { app: fakeApp, registered, internalByName }
  }

  describe('addHook fast path (no channel subscribers)', () => {
    it('forwards the user hook with the original done callback', () => {
      const { app, registered } = buildWrappedAddHook()

      const userHook = sinon.stub()
      app.addHook('preHandler', userHook)

      assert.equal(registered.length, 1)
      assert.equal(registered[0].name, 'preHandler')

      const wrapper = registered[0].fn
      const request = { cookies: {} }
      const reply = { send: () => {} }
      const done = sinon.stub()

      wrapper(request, reply, done)

      sinon.assert.calledOnce(userHook)
      assert.deepEqual(
        [userHook.firstCall.args[0], userHook.firstCall.args[1], userHook.firstCall.args[2]],
        [request, reply, done]
      )
      // The third arg must be the dispatcher's `done` itself - any mutation of
      // `arguments[arguments.length - 1]` inside the wrapper would replace it
      // with our rewrap closure instead.
      assert.strictEqual(userHook.firstCall.args[2], done)
    })

    it('handles variable hook arities without touching the trailing arg', () => {
      const { app, registered } = buildWrappedAddHook()

      const userHook = sinon.stub()
      app.addHook('preParsing', userHook)
      const wrapper = registered[0].fn

      const request = {}
      const reply = {}
      const payload = { /* fastify passes the request payload stream here */ }
      const done = sinon.stub()

      // preParsing dispatches with 4 args (request, reply, payload, done).
      wrapper(request, reply, payload, done)

      sinon.assert.calledOnce(userHook)
      assert.equal(userHook.firstCall.args.length, 4)
      assert.strictEqual(userHook.firstCall.args[3], done)
    })

    it('preserves the user hook name and length', () => {
      const { app, registered } = buildWrappedAddHook()

      function preHandlerHook (request, reply, done) { done() }
      app.addHook('preHandler', preHandlerHook)
      const wrapper = registered[0].fn

      assert.equal(wrapper.name, 'preHandlerHook')
      assert.equal(wrapper.length, preHandlerHook.length)
    })

    it('returns the value the user hook returns', () => {
      const { app, registered } = buildWrappedAddHook()

      const result = Symbol('user-result')
      const userHook = sinon.stub().returns(result)
      app.addHook('preHandler', userHook)
      const wrapper = registered[0].fn

      assert.strictEqual(wrapper({}, {}, () => {}), result)
    })

    it('forwards non-function arguments unwrapped', () => {
      const { app, registered } = buildWrappedAddHook()

      app.addHook('onRoute', 'not a function')
      assert.equal(registered.length, 1)
      assert.equal(registered[0].fn, 'not a function')
    })
  })

  describe('addHook slow path (channel subscribers attached)', () => {
    const subscriptions = []

    function subscribe (channel, listener) {
      channel.subscribe(listener)
      subscriptions.push({ channel, listener })
    }

    afterEach(() => {
      while (subscriptions.length > 0) {
        const { channel, listener } = subscriptions.pop()
        channel.unsubscribe(listener)
      }
    })

    it('catches and publishes synchronous errors when errorChannel has subscribers', () => {
      const errorListener = sinon.stub()
      subscribe(errorChannel, errorListener)

      const { app, registered } = buildWrappedAddHook()
      const error = new Error('boom')
      const userHook = sinon.stub().throws(error)
      app.addHook('preHandler', userHook)
      const wrapper = registered[0].fn

      assert.throws(() => wrapper({}, {}, () => {}), err => err === error)
      sinon.assert.calledOnce(errorListener)
      assert.strictEqual(errorListener.firstCall.args[0].error, error)
    })

    it('drops the re-entrant publish when an error subscriber re-enters another hook', () => {
      // A subscriber that drives another hook error while handling the current
      // one would loop publishError -> errorChannel -> subscriber -> hook ->
      // publishError until the stack overflows. The guard runs the subscriber once.
      const { app, registered } = buildWrappedAddHook()
      const userHook = sinon.stub().callsFake((request, reply, done) => done(new Error('boom')))
      app.addHook('preHandler', userHook)
      const wrapper = registered[0].fn

      let depth = 0
      const errorListener = sinon.stub().callsFake(() => {
        depth++
        if (depth > 50) return // safety stop: a regressed guard fails the assert, not the runner
        wrapper({}, {}, () => {})
      })
      subscribe(errorChannel, errorListener)

      wrapper({}, {}, () => {})

      assert.strictEqual(depth, 1)
    })

    it('publishes a persistent error once across sequential hook re-drives', () => {
      // #9099: fastify's boot loop (avvio _encapsulateThreeParam) re-invokes the
      // same encapsulated hook after a throw, and the same error object rides
      // every re-drive. Each re-drive is a fresh, sequential hook invocation -
      // not a nested re-entry - so the publish has already returned and a
      // module-level boolean has reset before the next one runs. Without an
      // error-keyed guard every re-drive republishes, the channel subscriber
      // recurses, and the boot overflows the stack. The wrapped hook must
      // publish the persistent error exactly once no matter how often it is
      // re-driven.
      const { app, registered } = buildWrappedAddHook()
      const persistentError = new Error('persistent boom')
      const userHook = sinon.stub().throws(persistentError)
      app.addHook('preHandler', userHook)
      const wrapper = registered[0].fn

      let publishCount = 0
      const errorListener = () => { publishCount++ }
      subscribe(errorChannel, errorListener)

      const redrives = 5000
      for (let i = 0; i < redrives; i++) {
        // Mirror avvio: the throw is caught by fastify's hook wrap and routed to
        // done(error); here we swallow it and drive the next iteration.
        assert.throws(() => wrapper({}, {}, () => {}), err => err === persistentError)
      }

      assert.strictEqual(publishCount, 1)
    })

    it('republishes a genuinely distinct error on each invocation', () => {
      // The guard keys on error identity, so distinct errors must each reach the
      // subscriber - the dedupe only collapses re-drives of the same object.
      const { app, registered } = buildWrappedAddHook()
      const userHook = sinon.stub().callsFake(() => { throw new Error('distinct ' + userHook.callCount) })
      app.addHook('preHandler', userHook)
      const wrapper = registered[0].fn

      let publishCount = 0
      const errorListener = () => { publishCount++ }
      subscribe(errorChannel, errorListener)

      for (let i = 0; i < 5; i++) {
        assert.throws(() => wrapper({}, {}, () => {}))
      }

      assert.strictEqual(publishCount, 5)
    })

    it('returns the user value unchanged when the hook is callbackless and returns non-thenable', () => {
      const errorListener = sinon.stub()
      subscribe(errorChannel, errorListener)

      const { app, registered } = buildWrappedAddHook()
      const result = Symbol('sync-non-thenable')
      const userHook = sinon.stub().returns(result)
      app.addHook('onReady', userHook)
      const wrapper = registered[0].fn

      // No trailing function arg, no thenable return - the slow path hits the
      // bare `return promise` branch without touching errorChannel.
      assert.strictEqual(wrapper({ sentinel: true }), result)
      sinon.assert.notCalled(errorListener)
    })

    it('publishes a rejected promise and re-rejects it when errorChannel has subscribers', async () => {
      const errorListener = sinon.stub()
      subscribe(errorChannel, errorListener)

      const { app, registered } = buildWrappedAddHook()
      const error = new Error('async boom')
      // The user hook returns a rejecting promise; fastify's application-hook
      // wrap (lib/hooks.js) reaches this branch when `fn.length === 0` and the
      // dispatcher does not pass a `done` callback.
      const userHook = sinon.stub().returns(Promise.reject(error))
      app.addHook('onReady', userHook)
      const wrapper = registered[0].fn

      // Invoke without a function trailing arg so we enter the promise branch.
      // The catch must publish the error and then re-reject; returning the error
      // would resolve the promise with it and silently swallow the rejection.
      await assert.rejects(wrapper({ sentinel: true }), err => err === error)

      sinon.assert.calledOnce(errorListener)
      assert.strictEqual(errorListener.firstCall.args[0].error, error)
    })

    it('publishes via errorChannel when the user hook reports failure through done(error)', () => {
      const errorListener = sinon.stub()
      subscribe(errorChannel, errorListener)

      const { app, registered } = buildWrappedAddHook()
      const userError = new Error('done(error) boom')
      const userHook = sinon.stub().callsFake((request, reply, done) => done(userError))
      app.addHook('preHandler', userHook)
      const wrapper = registered[0].fn

      const originalDone = sinon.stub()
      wrapper({}, {}, originalDone)

      sinon.assert.calledOnce(errorListener)
      assert.strictEqual(errorListener.firstCall.args[0].error, userError)
      sinon.assert.calledOnce(originalDone)
      assert.strictEqual(originalDone.firstCall.args[0], userError)
    })

    it('publishes cookies when cookieParserReadCh has subscribers and cookies are present', () => {
      const cookieListener = sinon.stub()
      subscribe(cookieParserReadCh, cookieListener)

      const { app, registered } = buildWrappedAddHook()
      const userHook = sinon.stub().callsFake((request, reply, done) => done())
      app.addHook('preHandler', userHook)
      const wrapper = registered[0].fn

      const request = { cookies: { token: 'abc' } }
      const reply = { raw: { headers: {} } }
      const originalDone = sinon.stub()
      wrapper(request, reply, originalDone)

      // The user hook saw a rewrapped done, distinct from the dispatcher's.
      assert.notStrictEqual(userHook.firstCall.args[2], originalDone)

      // The user hook then calls done, which triggers the cookie publish.
      sinon.assert.calledOnce(cookieListener)
      assert.deepEqual(cookieListener.firstCall.args[0].cookies, request.cookies)
      sinon.assert.calledOnce(originalDone)
    })

    it('skips the cookie publish when the request has no cookies', () => {
      const cookieListener = sinon.stub()
      subscribe(cookieParserReadCh, cookieListener)

      const { app, registered } = buildWrappedAddHook()
      const userHook = sinon.stub().callsFake((request, reply, done) => done())
      app.addHook('preHandler', userHook)
      const wrapper = registered[0].fn

      // No `cookies` on the request - pins the `hasCookies` false short-circuit
      // in wrapHookDone so the cookie publish is skipped without touching the
      // abortController / cookiesPublished side-tables.
      const originalDone = sinon.stub()
      wrapper({}, {}, originalDone)

      sinon.assert.notCalled(cookieListener)
      sinon.assert.calledOnce(originalDone)
    })

    it('does not republish cookies for a second invocation against the same request', () => {
      const cookieListener = sinon.stub()
      subscribe(cookieParserReadCh, cookieListener)

      const { app, registered } = buildWrappedAddHook()
      const userHook = sinon.stub().callsFake((request, reply, done) => done())
      app.addHook('preHandler', userHook)
      const wrapper = registered[0].fn

      // `cookiesPublished` is keyed on the underlying `req`; passing the same
      // request object twice keys both invocations to the same entry, so the
      // second pass takes the `cookiesPublished.has(req)` short-circuit.
      const request = { cookies: { token: 'abc' } }
      const reply = { raw: { headers: {} } }
      wrapper(request, reply, sinon.stub())
      wrapper(request, reply, sinon.stub())

      sinon.assert.calledOnce(cookieListener)
    })

    it('aborts the done chain when the cookie subscriber aborts', () => {
      const cookieListener = sinon.stub().callsFake(ctx => {
        ctx.abortController.abort()
      })
      subscribe(cookieParserReadCh, cookieListener)

      const { app, registered } = buildWrappedAddHook()
      const userHook = sinon.stub().callsFake((request, reply, done) => done())
      app.addHook('preHandler', userHook)
      const wrapper = registered[0].fn

      const request = { cookies: { token: 'abc' } }
      const reply = { raw: { headers: {} } }
      const originalDone = sinon.stub()
      wrapper(request, reply, originalDone)

      sinon.assert.calledOnce(cookieListener)
      // The cookie subscriber aborted before the dispatcher's `done` ran; the
      // user hook still ran (fastify dispatches it), but the trailing
      // doneCallback must not be invoked.
      sinon.assert.notCalled(originalDone)
    })

    it('falls through to the bare doneCallback for onRequest when callbackFinishCh has no subscribers', () => {
      // Enter the slow path through errorChannel so callbackFinishCh stays
      // subscriber-less; this exercises the `if (callbackFinishCh.hasSubscribers)`
      // false branch inside wrapHookDone for the onRequest / preParsing names.
      subscribe(errorChannel, sinon.stub())

      const { app, registered } = buildWrappedAddHook()
      const userHook = sinon.stub().callsFake((request, reply, done) => done())
      app.addHook('onRequest', userHook)
      const wrapper = registered[0].fn

      const originalDone = sinon.stub()
      wrapper({}, {}, originalDone)

      sinon.assert.calledOnce(originalDone)
    })

    it('runs the original done inside callbackFinishCh.runStores for onRequest hooks', () => {
      const callbackListener = sinon.stub()
      subscribe(callbackFinishCh, callbackListener)

      const { app, registered } = buildWrappedAddHook()
      const userHook = sinon.stub().callsFake((request, reply, done) => done())
      app.addHook('onRequest', userHook)
      const wrapper = registered[0].fn

      const request = {}
      const reply = {}
      const originalDone = sinon.stub()
      wrapper(request, reply, originalDone)

      // runStores publishes the data argument on the channel before running fn.
      sinon.assert.calledOnce(callbackListener)
      sinon.assert.calledOnce(originalDone)
    })

    it('runs the original done inside callbackFinishCh.runStores for preParsing hooks', () => {
      const callbackListener = sinon.stub()
      subscribe(callbackFinishCh, callbackListener)

      const { app, registered } = buildWrappedAddHook()
      const userHook = sinon.stub().callsFake((request, reply, payload, done) => done())
      app.addHook('preParsing', userHook)
      const wrapper = registered[0].fn

      const request = {}
      const reply = {}
      const payload = {}
      const originalDone = sinon.stub()
      wrapper(request, reply, payload, originalDone)

      sinon.assert.calledOnce(callbackListener)
      sinon.assert.calledOnce(originalDone)
    })

    it('publishes on every active channel when all three slow-path channels have subscribers', () => {
      const errorListener = sinon.stub()
      const cookieListener = sinon.stub()
      const callbackListener = sinon.stub()
      subscribe(errorChannel, errorListener)
      subscribe(cookieParserReadCh, cookieListener)
      subscribe(callbackFinishCh, callbackListener)

      const { app, registered } = buildWrappedAddHook()
      const userHook = sinon.stub().callsFake((request, reply, done) => done())
      app.addHook('onRequest', userHook)
      const wrapper = registered[0].fn

      const request = { cookies: { token: 'abc' } }
      const reply = { raw: { headers: {} } }
      const originalDone = sinon.stub()
      wrapper(request, reply, originalDone)

      sinon.assert.notCalled(errorListener)
      sinon.assert.calledOnce(cookieListener)
      sinon.assert.calledOnce(callbackListener)
      sinon.assert.calledOnce(originalDone)
    })

    it('preserves the user hook name and length in the slow path', () => {
      const errorListener = sinon.stub()
      subscribe(errorChannel, errorListener)

      const { app, registered } = buildWrappedAddHook()
      function namedHook (request, reply, done) { done() }
      app.addHook('preHandler', namedHook)
      const wrapper = registered[0].fn

      assert.equal(wrapper.name, 'namedHook')
      assert.equal(wrapper.length, namedHook.length)
    })
  })

  describe('preValidation -> processInContext (M13 hoist)', () => {
    const subscriptions = []

    function subscribe (channel, listener) {
      channel.subscribe(listener)
      subscriptions.push({ channel, listener })
    }

    afterEach(() => {
      while (subscriptions.length > 0) {
        const { channel, listener } = subscriptions.pop()
        channel.unsubscribe(listener)
      }
    })

    function runPhases ({ request, reply }) {
      const { internalByName } = buildWrappedAddHook()
      const [preParsingFn] = internalByName('preParsing')
      const [preValidationFn] = internalByName('preValidation')

      const preParsingDone = sinon.stub()
      preParsingFn(request, reply, undefined, preParsingDone)
      sinon.assert.calledOnce(preParsingDone)

      const preValidationDone = sinon.stub()
      preValidationFn(request, reply, preValidationDone)
      return { preValidationDone }
    }

    it('publishes query / body / path params when their channels have subscribers', () => {
      const queryListener = sinon.stub()
      const bodyListener = sinon.stub()
      const pathListener = sinon.stub()
      subscribe(queryParamsReadCh, queryListener)
      subscribe(bodyParserReadCh, bodyListener)
      subscribe(pathParamsReadCh, pathListener)

      const request = { query: { q: '1' }, body: { b: '2' }, params: { p: '3' } }
      const reply = {}
      const { preValidationDone } = runPhases({ request, reply })

      sinon.assert.calledOnce(queryListener)
      sinon.assert.calledOnce(bodyListener)
      sinon.assert.calledOnce(pathListener)
      sinon.assert.calledOnce(preValidationDone)
    })

    it('skips parser publishes when the channels have no subscribers', () => {
      const queryListener = sinon.stub()
      // Subscribe to a sibling channel; the parser channels stay empty.
      subscribe(errorChannel, queryListener)

      const request = { query: { q: '1' }, body: { b: '2' }, params: { p: '3' } }
      const reply = {}
      const { preValidationDone } = runPhases({ request, reply })

      // The parser path runs, sees `hasSubscribers === false`, and calls done.
      sinon.assert.calledOnce(preValidationDone)
    })

    it('aborts the validation chain when a subscriber aborts via the abortController', () => {
      const queryListener = sinon.stub().callsFake(ctx => {
        ctx.abortController.abort()
      })
      subscribe(queryParamsReadCh, queryListener)

      const request = { query: { q: '1' }, body: { b: '2' }, params: { p: '3' } }
      const reply = {}
      const { preValidationDone } = runPhases({ request, reply })

      sinon.assert.calledOnce(queryListener)
      sinon.assert.notCalled(preValidationDone)
    })

    it('aborts the chain when the body parser subscriber aborts', () => {
      // No query subscriber, so processInContext falls into the body branch
      // first; aborting from there pins the body-side `signal.aborted` exit.
      const bodyListener = sinon.stub().callsFake(ctx => {
        ctx.abortController.abort()
      })
      const pathListener = sinon.stub()
      subscribe(bodyParserReadCh, bodyListener)
      subscribe(pathParamsReadCh, pathListener)

      const request = { body: { b: '2' }, params: { p: '3' } }
      const reply = {}
      const { preValidationDone } = runPhases({ request, reply })

      sinon.assert.calledOnce(bodyListener)
      sinon.assert.notCalled(pathListener)
      sinon.assert.notCalled(preValidationDone)
    })

    it('aborts the chain when the path params subscriber aborts', () => {
      const pathListener = sinon.stub().callsFake(ctx => {
        ctx.abortController.abort()
      })
      subscribe(pathParamsReadCh, pathListener)

      const request = { params: { p: '3' } }
      const reply = {}
      const { preValidationDone } = runPhases({ request, reply })

      sinon.assert.calledOnce(pathListener)
      sinon.assert.notCalled(preValidationDone)
    })

    it('publishes the body once per request even when the channel is reentered', () => {
      const bodyListener = sinon.stub()
      subscribe(bodyParserReadCh, bodyListener)

      // `bodyPublished` is a WeakSet keyed on the underlying `req`; running the
      // preValidation phase twice against the same request must not republish.
      const { internalByName } = buildWrappedAddHook()
      const [preParsingFn] = internalByName('preParsing')
      const [preValidationFn] = internalByName('preValidation')

      const request = { body: { b: '2' } }
      const reply = {}
      preParsingFn(request, reply, undefined, sinon.stub())

      preValidationFn(request, reply, sinon.stub())
      preValidationFn(request, reply, sinon.stub())

      sinon.assert.calledOnce(bodyListener)
    })

    it('forwards done without touching ctx when preParsing left no stored context', () => {
      // fastify dispatches preValidation even when the preParsing phase never
      // ran for this request, so `parsingContexts` has no entry. The
      // missing-context guard must short-circuit before any `ctx` access, even
      // when a param channel has a subscriber - otherwise processInContext
      // dereferences the missing ctx (ctx.abortController = ...) and throws.
      const queryListener = sinon.stub()
      subscribe(queryParamsReadCh, queryListener)

      const { internalByName } = buildWrappedAddHook()
      const [preValidationFn] = internalByName('preValidation')

      const request = { query: { q: '1' }, body: { b: '2' }, params: { p: '3' } }
      const reply = {}
      const preValidationDone = sinon.stub()

      preValidationFn(request, reply, preValidationDone)

      sinon.assert.calledOnce(preValidationDone)
      // No ctx means nothing to publish on, so the param channel stays untouched.
      sinon.assert.notCalled(queryListener)
    })
  })

  describe('wrapSend (reply.send error publishing)', () => {
    const subscriptions = []

    function subscribe (channel, listener) {
      channel.subscribe(listener)
      subscriptions.push({ channel, listener })
    }

    afterEach(() => {
      while (subscriptions.length > 0) {
        const { channel, listener } = subscriptions.pop()
        channel.unsubscribe(listener)
      }
    })

    it('publishes through the guarded publishError when reply.send is called with an Error', () => {
      const errorListener = sinon.stub()
      subscribe(errorChannel, errorListener)

      const { internalByName } = buildWrappedAddHook()
      const [preHandlerFn] = internalByName('preHandler')

      // preHandler swaps reply.send for the tracing wrapper (wrapSend).
      const originalSend = sinon.stub()
      const reply = { send: originalSend }
      const preHandlerDone = sinon.stub()
      preHandlerFn({}, reply, preHandlerDone)
      sinon.assert.calledOnce(preHandlerDone)
      assert.notStrictEqual(reply.send, originalSend)

      // Sending an Error routes through publishError, not a bare errorChannel.publish.
      const error = new Error('send boom')
      reply.send(error)

      sinon.assert.calledOnce(errorListener)
      assert.strictEqual(errorListener.firstCall.args[0].error, error)
      // The original send still runs with the untouched arguments.
      sinon.assert.calledOnce(originalSend)
      assert.strictEqual(originalSend.firstCall.args[0], error)
    })
  })
})
