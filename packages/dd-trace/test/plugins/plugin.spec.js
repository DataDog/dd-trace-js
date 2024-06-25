'use strict'

require('../setup/tap')

const Plugin = require('../../src/plugins/plugin')
const plugins = require('../../src/plugins')
const { channel } = require('dc-polyfill')

describe('Plugin', () => {
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
      this.addSub('apm:badPlugin:start', this.start)
    }

    start () {
      //
    }
  }

  const testPlugins = { badPlugin: BadPlugin, goodPlugin: GoodPlugin }
  const loadChannel = channel('dd-trace:instrumentation:load')

  before(() => {
    for (const [name, cls] of Object.entries(testPlugins)) {
      plugins[name] = cls
      loadChannel.publish({ name })
    }
  })
  after(() => { Object.keys(testPlugins).forEach(name => delete plugins[name]) })

  it('should disable upon error', () => {

    const plugin = new BadPlugin()
    plugin.configure({ enabled: true })

    expect(plugin._enabled).to.be.true

    channel('apm:badPlugin:start').publish({ foo: 'bar' })

    expect(plugin._enabled).to.be.false
  })

  it('should not disable with no error', () => {
    const plugin = new GoodPlugin()
    plugin.configure({ enabled: true })

    expect(plugin._enabled).to.be.true

    channel('apm:goodPlugin:start').publish({ foo: 'bar' })

    expect(plugin._enabled).to.be.true
  })
})
