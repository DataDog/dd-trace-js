'use strict'

const { expect } = require('chai')
const { describe, it, after } = require('tap').mocha
const { channel } = require('dc-polyfill')

require('../setup/core')

const Plugin = require('../../src/plugins/plugin')
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
      //
    }
  }

  after(() => {
    plugin.configure({ enabled: false })
  })

  it('should disable upon error', () => {
    plugin = new BadPlugin()
    plugin.configure({ enabled: true })

    expect(plugin._enabled).to.be.true

    channel('apm:badPlugin:start').publish({ foo: 'bar' })

    expect(plugin._enabled).to.be.false
  })

  it('should not disable with no error', () => {
    plugin = new GoodPlugin()
    plugin.configure({ enabled: true })

    expect(plugin._enabled).to.be.true

    channel('apm:goodPlugin:start').publish({ foo: 'bar' })

    expect(plugin._enabled).to.be.true
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
        expect(storage('legacy').getStore()).to.equal(undefined)
      })
    })
  })
})
