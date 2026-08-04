'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, before, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const errorChannel = dc.channel('apm:restify:middleware:error')

const serverMethods = ['del', 'get', 'head', 'opts', 'post', 'put', 'patch', 'use', 'pre', '_setupRequest']

describe('restify instrumentation (unit)', () => {
  let restifyHook
  const subscriptions = []

  before(() => {
    const realInstrument = require('../src/helpers/instrument')
    const addHookSpy = sinon.spy()
    proxyquire('../src/restify', {
      './helpers/instrument': { ...realInstrument, addHook: addHookSpy },
    })
    const call = addHookSpy.getCalls().find(c => c.args[0].name === 'restify')
    restifyHook = call.args[1]
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

  /**
   * Run the dd-trace hook against a fake Server and return the wrapped
   * middleware the route method installed for `handler`.
   *
   * @param {Function} handler
   */
  function buildWrappedMiddleware (handler) {
    function FakeServer () {}
    for (const method of serverMethods) {
      FakeServer.prototype[method] = function () {}
    }
    FakeServer.prototype.get = function (path, ...middlewares) {
      this.captured = middlewares
    }

    restifyHook(FakeServer)

    const server = new FakeServer()
    server.get('/route', handler)
    return server.captured[0]
  }

  it('publishes the error through the guard when the handler rejects', async () => {
    const failure = new Error('boom')
    const wrappedMiddleware = buildWrappedMiddleware(() => Promise.reject(failure))

    let published
    subscribe(errorChannel, ({ error }) => { published = error })

    await assert.rejects(() => wrappedMiddleware.call({}, {}, {}, () => {}), error => error === failure)
    assert.strictEqual(published, failure)
  })

  it('drops the re-entrant publish when an error subscriber re-runs the handler', () => {
    const wrappedMiddleware = buildWrappedMiddleware(function thrower () { throw new Error('boom') })

    // A subscriber that re-runs the handler while handling the error loops
    // errorChannel -> subscriber -> throw -> errorChannel until the stack
    // overflows. The guard runs the subscriber once.
    let depth = 0
    const errorListener = () => {
      depth++
      if (depth > 50) return // safety stop: a regressed guard fails the assert, not the runner
      try {
        wrappedMiddleware.call({}, {}, {}, () => {})
      } catch {
        // the synchronous handler re-throws; swallow so the loop can continue
      }
    }
    subscribe(errorChannel, errorListener)

    assert.throws(() => wrappedMiddleware.call({}, {}, {}, () => {}))
    assert.strictEqual(depth, 1)
  })
})
