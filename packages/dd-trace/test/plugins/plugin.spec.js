'use strict'

const assert = require('node:assert')

const { describe, it, after } = require('tap').mocha
const { channel } = require('dc-polyfill')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

const log = {
  error: sinon.stub(),
  info: sinon.stub()
}

const Plugin = proxyquire('../../src/plugins/plugin', {
  '../log': log
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
})
