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
    it('should return the store written into storage carrying the span', () => {
      const parentSpan = { id: 'parent' }
      const span = { id: 'child' }

      plugin = new GoodPlugin()

      const entered = plugin.enter(span, { span: parentSpan })

      assert.strictEqual(entered.span, span)
      // The returned object is the one written into storage, so a caller that
      // holds it can drop the finished span from any frame captured off it.
      assert.strictEqual(storage('legacy').getStore(), entered)
    })

    it('should extend the current store when none is passed', () => {
      const span = { id: 'child' }

      plugin = new GoodPlugin()

      storage('legacy').run({ existing: true, span: undefined }, () => {
        const entered = plugin.enter(span)

        assert.deepStrictEqual(entered, { existing: true, span })
        assert.strictEqual(storage('legacy').getStore(), entered)
      })
    })

    it('should let a caller drop the finished span by nulling the returned store', () => {
      const span = { id: 'child' }

      plugin = new GoodPlugin()
      const entered = plugin.enter(span, { span: undefined })

      assert.strictEqual(entered.span, span)

      // The release contract callers rely on at request finish: nulling the
      // returned store's span means a frame that captured it stops pinning it.
      entered.span = null

      assert.strictEqual(entered.span, null)
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
