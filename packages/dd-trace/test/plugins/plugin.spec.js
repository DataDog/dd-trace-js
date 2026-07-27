'use strict'

const assert = require('node:assert')

const { describe, it, after } = require('mocha')
const { channel } = require('dc-polyfill')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

const log = {
  error: sinon.stub(),
  info: sinon.stub(),
}

const Plugin = proxyquire('../../src/plugins/plugin', {
  '../log': log,
})
const { storage } = require('../../../datadog-core')

describe('Plugin', () => {
  let plugin

  class BadPlugin extends Plugin {
    static id = 'badPlugin'

    constructor () {
      super()
      this.addSub('apm:badPlugin:start', this.start)
    }

    start () {
      throw new Error('this is one bad plugin')
    }
  }

  class GoodPlugin extends Plugin {
    static id = 'goodPlugin'

    constructor () {
      super()
      this.addSub('apm:goodPlugin:start', this.start)
    }

    start () {
      assert.strictEqual(this, plugin)
    }
  }

  after(() => {
    plugin.configure({ enabled: false })
  })

  it('should disable upon error', () => {
    plugin = new BadPlugin()
    plugin.configure({ enabled: true })

    assert.strictEqual(plugin._enabled, true)

    channel('apm:badPlugin:start').publish({ foo: 'bar' })

    sinon.assert.calledWith(log.error, 'Error in plugin handler:', sinon.match.instanceOf(Error))
    sinon.assert.calledWith(log.info, 'Disabling plugin: %s', 'BadPlugin')

    assert.strictEqual(plugin._enabled, false)
  })

  it('should not disable with no error', () => {
    plugin = new GoodPlugin()
    plugin.configure({ enabled: true })

    assert.strictEqual(plugin._enabled, true)

    channel('apm:goodPlugin:start').publish({ foo: 'bar' })

    assert.strictEqual(plugin._enabled, true)
  })

  describe('enter', () => {
    it('should return the store it entered so callers can release it later', () => {
      const parentSpan = { id: 'parent' }
      const span = { id: 'child' }

      plugin = new GoodPlugin()

      const entered = plugin.enter(span, { span: parentSpan })

      // The entered store is a fresh object carrying the new active span.
      assert.strictEqual(typeof entered, 'object')
      assert.strictEqual(entered.span, span)
      // It is the same object written into storage, so mutating it later
      // affects what any async resource captured off that frame retains.
      assert.strictEqual(storage('legacy').getStore(), entered)
    })
  })

  describe('releaseSpan', () => {
    it('should null the span reference on the given store', () => {
      const span = { id: 'child' }
      const store = { span }

      plugin = new GoodPlugin()
      plugin.releaseSpan(store)

      // Releasing lets a finished span be collected even while an async resource
      // that captured this store lives on. This is the core of the fix for the
      // unbounded router.middleware span retention leak.
      assert.strictEqual(store.span, null)
    })

    it('should not throw for a missing store or a store without a span', () => {
      plugin = new GoodPlugin()

      // Executed directly: the test fails if any of these throw.
      plugin.releaseSpan()
      plugin.releaseSpan(undefined)
      plugin.releaseSpan({})
    })
  })

  it('should run binding transforms with an undefined current store', () => {
    class TestPlugin extends Plugin {
      static id = 'test'

      constructor () {
        super()
        this.addBind('apm:test:start', ctx => ctx.currentStore)
      }
    }

    plugin = new TestPlugin()
    plugin.configure({ enabled: true })

    storage('legacy').run({ noop: true }, () => {
      channel('apm:test:start').runStores({ currentStore: undefined }, () => {
        assert.strictEqual(storage('legacy').getStore(), undefined)
      })
    })
  })

  it('should suppress subscribers when publishing inside a noop scope', () => {
    const handler = sinon.spy()

    class NoopAwarePlugin extends Plugin {
      static id = 'noopAware'

      constructor () {
        super()
        this.addSub('apm:noopAware:start', handler)
      }
    }

    plugin = new NoopAwarePlugin()
    plugin.configure({ enabled: true })

    channel('apm:noopAware:start').publish({ outside: true })
    sinon.assert.calledOnce(handler)
    handler.resetHistory()

    storage('legacy').run({ noop: true }, () => {
      channel('apm:noopAware:start').publish({ inside: true })
    })
    sinon.assert.notCalled(handler)

    channel('apm:noopAware:start').publish({ outside: 'again' })
    sinon.assert.calledOnce(handler)
  })
})
