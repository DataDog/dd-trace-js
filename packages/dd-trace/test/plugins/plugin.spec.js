'use strict'

const t = require('tap')
require('../setup/core')

const Plugin = require('../../src/plugins/plugin')
const { storage } = require('../../../datadog-core')
const { channel } = require('dc-polyfill')

t.test('Plugin', t => {
  let plugin

  class BadPlugin extends Plugin {
    static get id () { return 'badPlugin' }

    constructor () {
      super()
      this.addSub('apm:badPlugin:start', this.start)
    }

    start () {
      throw new Error('this is one bad plugin')
    }
  }

  class GoodPlugin extends Plugin {
    static get id () { return 'goodPlugin' }

    constructor () {
      super()
      this.addSub('apm:goodPlugin:start', this.start)
    }

    start () {
      //
    }
  }

  t.after(() => {
    plugin.configure({ enabled: false })
  })

  t.test('should disable upon error', t => {
    plugin = new BadPlugin()
    plugin.configure({ enabled: true })

    expect(plugin._enabled).to.be.true

    channel('apm:badPlugin:start').publish({ foo: 'bar' })

    expect(plugin._enabled).to.be.false
    t.end()
  })

  t.test('should not disable with no error', t => {
    plugin = new GoodPlugin()
    plugin.configure({ enabled: true })

    expect(plugin._enabled).to.be.true

    channel('apm:goodPlugin:start').publish({ foo: 'bar' })

    expect(plugin._enabled).to.be.true
    t.end()
  })

  t.test('should run binding transforms with an undefined current store', t => {
    class TestPlugin extends Plugin {
      static get id () { return 'test' }

      constructor () {
        super()
        this.addBind('apm:test:start', ctx => ctx.currentStore)
      }
    }

    plugin = new TestPlugin()
    plugin.configure({ enabled: true })

    storage('legacy').run({ noop: true }, () => {
      channel('apm:test:start').runStores({ currentStore: undefined }, () => {
        expect(storage('legacy').getStore()).to.equal(undefined)
      })
    })
    t.end()
  })
  t.end()
})
