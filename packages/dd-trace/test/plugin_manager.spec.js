'use strict'

const proxyquire = require('proxyquire')

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
  })

  describe('configurePlugin', () => {
    it('does not throw for old-style plugins', () => {
      expect(() => pm.configurePlugin('one', false)).to.not.throw()
    })
    describe('without configure', () => {
      it('should not configure plugins', () => {
        pm.configurePlugin('two')
        expect(Two.prototype.configure).to.not.have.been.called
      })
      it('should keep the config for future configure calls', () => {
        pm.configurePlugin('two', { foo: 'bar' })
        pm.configure()
        expect(Two.prototype.configure).to.have.been.calledWith({
          enabled: true,
          foo: 'bar'
        })
      })
    })
    describe('without env vars', () => {
      beforeEach(() => pm.configure())

      it('works with no config param', () => {
        pm.configure()
        pm.configurePlugin('two')
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: true })
      })
      it('works with empty object config', () => {
        pm.configure()
        pm.configurePlugin('two', {})
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: true })
      })
      it('works with "enabled: false" object config', () => {
        pm.configure()
        pm.configurePlugin('two', { enabled: false })
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: false })
      })
      it('works with "enabled: true" object config', () => {
        pm.configure()
        pm.configurePlugin('two', { enabled: true })
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: true })
      })
      it('works with boolean false', () => {
        pm.configure()
        pm.configurePlugin('two', false)
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: false })
      })
      it('works with boolean true', () => {
        pm.configure()
        pm.configurePlugin('two', true)
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: true })
      })
    })
    describe('with disabled plugins', () => {
      it('should not call configure on individual enable override', () => {
        pm.configure()
        pm.configurePlugin('five', { enabled: true })
        expect(Five.prototype.configure).to.not.have.been.called
      })
      it('should not configure all disabled plugins', () => {
        pm.configure({})
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
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: true })
      })
      it('works with empty object config', () => {
        pm.configurePlugin('two', {})
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: true })
      })
      it('works with "enabled: false" object config', () => {
        pm.configurePlugin('two', { enabled: false })
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: true })
      })
      it('works with "enabled: true" object config', () => {
        pm.configurePlugin('two', { enabled: true })
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: true })
      })
      it('works with boolean false', () => {
        pm.configurePlugin('two', false)
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: true })
      })
      it('works with boolean true', () => {
        pm.configurePlugin('two', true)
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
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: false })
      })
      it('works with empty object config', () => {
        pm.configurePlugin('two', {})
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: false })
      })
      it('works with "enabled: false" object config', () => {
        pm.configurePlugin('two', { enabled: false })
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: false })
      })
      it('works with "enabled: true" object config', () => {
        pm.configurePlugin('two', { enabled: true })
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: false })
      })
      it('works with boolean false', () => {
        pm.configurePlugin('two', false)
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: false })
      })
      it('works with boolean true', () => {
        pm.configurePlugin('two', true)
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: false })
      })
    })
  })

  describe('configure', () => {
    it('instantiates plugin classes', () => {
      pm.configure()
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
        logInjection: true
      })
      expect(Two.prototype.configure).to.have.been.calledWith({ enabled: true, service: 'deux', logInjection: true })
      expect(Four.prototype.configure).to.have.been.calledWith({ enabled: true, logInjection: true })
    })
  })

  describe('destroy', () => {
    beforeEach(() => pm.configure())

    it('should disable the plugins', () => {
      pm.destroy()
      expect(Two.prototype.configure).to.have.been.calledWith({ enabled: false })
      expect(Four.prototype.configure).to.have.been.calledWith({ enabled: false })
    })
  })
})
