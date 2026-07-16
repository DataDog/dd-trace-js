'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, before, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const enterChannel = dc.channel('apm:connect:middleware:enter')
const errorChannel = dc.channel('apm:connect:middleware:error')

describe('connect instrumentation (unit)', () => {
  let connectHook
  const subscriptions = []

  before(() => {
    const realInstrument = require('../src/helpers/instrument')
    const addHookSpy = sinon.spy()
    proxyquire('../src/connect', {
      './helpers/instrument': { ...realInstrument, addHook: addHookSpy },
    })
    const call = addHookSpy.getCalls().find(c => {
      const target = c.args[0]
      return target.name === 'connect' && target.versions?.[0] === '>=3.4.0'
    })
    connectHook = call.args[1]
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
   * Run the dd-trace factory against a fake connect app and return the layer
   * handle the wrap installed for `middleware`.
   *
   * @param {Function} middleware
   */
  function buildLayerHandle (middleware) {
    function fakeConnect () {
      return {
        stack: [],
        use (fn) { this.stack.push({ handle: fn }) },
        handle () {},
      }
    }
    const app = connectHook(fakeConnect)()
    app.use(middleware)
    return app.stack[0].handle
  }

  it('publishes the error through the guard when the layer throws synchronously', () => {
    subscribe(enterChannel, () => {})

    const failure = new Error('boom')
    const handle = buildLayerHandle(() => { throw failure })

    let published
    subscribe(errorChannel, ({ error }) => { published = error })

    assert.throws(() => handle.call({}, {}, {}, () => {}), error => error === failure)
    assert.strictEqual(published, failure)
  })

  it('drops the re-entrant publish when an error subscriber re-runs the layer', () => {
    // enterChannel needs a subscriber or wrapLayerHandle takes the fast path.
    subscribe(enterChannel, () => {})

    const handle = buildLayerHandle((req, res, next) => next(new Error('boom')))

    // A subscriber that re-runs the layer while handling the error loops
    // errorChannel -> subscriber -> next(error) -> errorChannel until the stack
    // overflows. The guard runs the subscriber once.
    let depth = 0
    const errorListener = () => {
      depth++
      if (depth > 50) return // safety stop: a regressed guard fails the assert, not the runner
      handle.call({}, {}, {}, () => {})
    }
    subscribe(errorChannel, errorListener)

    handle.call({}, {}, {}, () => {})

    assert.strictEqual(depth, 1)
  })
})
