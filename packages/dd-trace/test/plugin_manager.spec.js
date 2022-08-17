'use strict'

const { channel } = require('diagnostics_channel')
const proxyquire = require('proxyquire')

const loadChannel = channel('dd-trace:instrumentation:load')

describe('Plugin Manager', () => {
  let tracer
  let instantiated
  let PluginManager
  let Two
  let Four
  let Five
  let Six
  let pm

  beforeEach(() => {
    tracer = {}
    instantiated = []
    class FakePlugin {
      constructor (aTracer) {
        expect(aTracer).to.equal(tracer)
        instantiated.push(this.constructor.name)
      }
    }

    const plugins = {
      one: {},
      two: class Two extends FakePlugin {
        static get name () {
          return 'two'
        }
      },
      three: {},
      four: class Four extends FakePlugin {
        static get name () {
          return 'four'
        }
      },
      five: class Five extends FakePlugin {
        static get name () {
          return 'five'
        }
      },
      six: class Six extends FakePlugin {
        static get name () {
          return 'six'
        }
      },
      seven: {}
    }

    Two = plugins.two
    Two.prototype.configure = sinon.spy()
    Four = plugins.four
    Four.prototype.configure = sinon.spy()

    // disabled plugins
    Five = plugins.five
    Five.prototype.configure = sinon.spy()
    Six = plugins.six
    Six.prototype.configure = sinon.spy()

    process.env.DD_TRACE_DISABLED_PLUGINS = 'five,six,seven'

    PluginManager = proxyquire.noPreserveCache()('../src/plugin_manager', {
      './plugins': { ...plugins, '@noCallThru': true },
      '../../datadog-instrumentations': {}
    })
    pm = new PluginManager(tracer)
  })

  afterEach(() => {
    delete process.env.DD_TRACE_DISABLED_PLUGINS
    pm.destroy()
  })

  describe('configurePlugin', () => {
    it('does not throw for old-style plugins', () => {
      expect(() => pm.configurePlugin('one', false)).to.not.throw()
    })
    describe('without configure', () => {
      it('should not configure plugins', () => {
        pm.configurePlugin('two')
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.not.have.been.called
      })
      it('should keep the config for future configure calls', () => {
        pm.configurePlugin('two', { foo: 'bar' })
        pm.configure()
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWith({
          enabled: true,
          foo: 'bar'
        })
      })
    })
    describe('without env vars', () => {
      beforeEach(() => pm.configure())
      it('works with no config param', () => {
        pm.configurePlugin('two')
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: true })
      })
      it('works with empty object config', () => {
        pm.configurePlugin('two', {})
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: true })
      })
      it('works with "enabled: false" object config', () => {
        pm.configurePlugin('two', { enabled: false })
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: false })
      })
      it('works with "enabled: true" object config', () => {
        pm.configurePlugin('two', { enabled: true })
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: true })
      })
      it('works with boolean false', () => {
        pm.configurePlugin('two', false)
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: false })
      })
      it('works with boolean true', () => {
        pm.configurePlugin('two', true)
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: true })
      })
    })
    describe('with disabled plugins', () => {
      beforeEach(() => pm.configure())
      it('should not call configure on individual enable override', () => {
        pm.configurePlugin('five', { enabled: true })
        loadChannel.publish({ name: 'five' })
        expect(Five.prototype.configure).to.not.have.been.called
      })
      it('should not configure all disabled plugins', () => {
        pm.configure({})
        loadChannel.publish({ name: 'five' })
        expect(Five.prototype.configure).to.not.have.been.called
        expect(Six.prototype.configure).to.not.have.been.called
      })
    })
    describe('with env var true', () => {
      beforeEach(() => pm.configure())
      beforeEach(() => {
        process.env.DD_TRACE_TWO_ENABLED = '1'
      })
      afterEach(() => {
        delete process.env.DD_TRACE_TWO_ENABLED
      })
      it('works with no config param', () => {
        pm.configurePlugin('two')
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: true })
      })
      it('works with empty object config', () => {
        pm.configurePlugin('two', {})
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: true })
      })
      it('works with "enabled: false" object config', () => {
        pm.configurePlugin('two', { enabled: false })
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: false })
      })
      it('works with "enabled: true" object config', () => {
        pm.configurePlugin('two', { enabled: true })
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: true })
      })
      it('works with boolean false', () => {
        pm.configurePlugin('two', false)
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: false })
      })
      it('works with boolean true', () => {
        pm.configurePlugin('two', true)
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: true })
      })
    })
    describe('with env var false', () => {
      beforeEach(() => pm.configure())
      beforeEach(() => {
        process.env.DD_TRACE_TWO_ENABLED = '0'
      })
      afterEach(() => {
        delete process.env.DD_TRACE_TWO_ENABLED
      })
      it('works with no config param', () => {
        pm.configurePlugin('two')
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.not.have.been.called
      })
      it('works with empty object config', () => {
        pm.configurePlugin('two', {})
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.not.have.been.called
      })
      it('works with "enabled: false" object config', () => {
        pm.configurePlugin('two', { enabled: false })
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.not.have.been.called
      })
      it('works with "enabled: true" object config', () => {
        pm.configurePlugin('two', { enabled: true })
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.not.have.been.called
      })
      it('works with boolean false', () => {
        pm.configurePlugin('two', false)
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.not.have.been.called
      })
      it('works with boolean true', () => {
        pm.configurePlugin('two', true)
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.not.have.been.called
      })
    })
  })

  describe('configure', () => {
    describe('without the load event', () => {
      it('should not instantiate plugins', () => {
        pm.configure()
        pm.configurePlugin('two')
        expect(instantiated).to.be.empty
        expect(Two.prototype.configure).to.not.have.been.called
      })
    })
    it('instantiates plugin classes', () => {
      pm.configure()
      loadChannel.publish({ name: 'two' })
      loadChannel.publish({ name: 'four' })
      expect(instantiated).to.deep.equal(['two', 'four'])
    })
    it('skips configuring plugins entirely when plugins is false', () => {
      pm.configurePlugin = sinon.spy()
      pm.configure({ plugins: false })
      expect(pm.configurePlugin).not.to.have.been.called
    })
    it('observes configuration options', () => {
      pm.configure({
        serviceMapping: { two: 'deux' },
        logInjection: true,
        queryStringObfuscation: '.*'
      })
      loadChannel.publish({ name: 'two' })
      loadChannel.publish({ name: 'four' })
      expect(Two.prototype.configure).to.have.been.calledWith({
        enabled: true,
        service: 'deux',
        logInjection: true,
        queryStringObfuscation: '.*'
      })
      expect(Four.prototype.configure).to.have.been.calledWith({
        enabled: true,
        logInjection: true,
        queryStringObfuscation: '.*'
      })
    })
  })

  describe('destroy', () => {
    beforeEach(() => pm.configure())
    it('should disable the plugins', () => {
      loadChannel.publish({ name: 'two' })
      loadChannel.publish({ name: 'four' })
      pm.destroy()
      expect(Two.prototype.configure).to.have.been.calledWith({ enabled: false })
      expect(Four.prototype.configure).to.have.been.calledWith({ enabled: false })
    })
  })
})
