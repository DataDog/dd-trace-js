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

    it('captures rejected promises when errorChannel has subscribers', async () => {
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
      await wrapper({ sentinel: true })

      sinon.assert.calledOnce(errorListener)
      assert.strictEqual(errorListener.firstCall.args[0].error, error)
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
  })
})
