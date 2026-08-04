'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, before, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const enterChannel = dc.channel('apm:koa:middleware:enter')
const errorChannel = dc.channel('apm:koa:middleware:error')

describe('koa instrumentation (unit)', () => {
  let koaHook
  const subscriptions = []

  before(() => {
    const realInstrument = require('../src/helpers/instrument')
    const addHookSpy = sinon.spy()
    proxyquire('../src/koa', {
      './helpers/instrument': { ...realInstrument, addHook: addHookSpy },
    })
    const call = addHookSpy.getCalls().find(c => c.args[0].name === 'koa')
    koaHook = call.args[1]
  })

  function subscribe (channel, listener) {
    channel.subscribe(listener)
    subscriptions.push([channel, listener])
  }

  afterEach(() => {
    while (subscriptions.length > 0) {
      const [channel, listener] = subscriptions.pop()
      channel.unsubscribe(listener)
    }
  })

  // Run the dd-trace hook against a fake Koa app and return the wrapped
  // middleware `use` installed for a synchronously throwing handler.
  function buildThrowingMiddleware () {
    function FakeKoa () {
      this.middleware = []
    }
    FakeKoa.prototype.use = function (fn) { this.middleware.push(fn) }
    FakeKoa.prototype.callback = function () {}

    koaHook(FakeKoa)

    const app = new FakeKoa()
    app.use(function thrower () { throw new Error('boom') })
    return app.middleware[0]
  }

  it('drops the re-entrant publish when an error subscriber re-runs the handler', () => {
    // enterChannel needs a subscriber or wrapMiddleware takes the fast path.
    subscribe(enterChannel, () => {})

    const wrappedMiddleware = buildThrowingMiddleware()
    const ctx = { req: {} }

    // A subscriber that re-runs the handler while handling the error loops
    // errorChannel -> subscriber -> throw -> errorChannel until the stack
    // overflows. The guard runs the subscriber once.
    let depth = 0
    const errorListener = () => {
      depth++
      if (depth > 50) return // safety stop: a regressed guard fails the assert, not the runner
      try {
        wrappedMiddleware.call({}, ctx, () => {})
      } catch {
        // the synchronous handler re-throws; swallow so the loop can continue
      }
    }
    subscribe(errorChannel, errorListener)

    assert.throws(() => wrappedMiddleware.call({}, ctx, () => {}))
    assert.strictEqual(depth, 1)
  })
})
