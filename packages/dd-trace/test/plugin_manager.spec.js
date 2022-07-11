'use strict'

const proxyquire = require('proxyquire')

describe('Plugin Manager', () => {
  let tracer
  let instantiated
  let PluginManager
  let Two
  let Four
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
      }
    }

    Two = plugins.two
    Two.prototype.configure = sinon.spy()
    Four = plugins.four
    Four.prototype.configure = sinon.spy()

    PluginManager = proxyquire.noPreserveCache()('../src/plugin_manager', {
      './plugins': { ...plugins, '@noCallThru': true },
      '../../datadog-instrumentations': {}
    })
    pm = new PluginManager(tracer)
  })

  describe('constructor', () => {
    it('instantiates plugin classes', () => {
      expect(instantiated).to.deep.equal(['two', 'four'])
    })
  })

  describe('configurePlugin', () => {
    it('does not throw for old-style plugins', () => {
      expect(() => pm.configurePlugin('one', false)).to.not.throw()
    })
    describe('without env vars', () => {
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
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: false })
      })
      it('works with "enabled: true" object config', () => {
        pm.configurePlugin('two', { enabled: true })
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: true })
      })
      it('works with boolean false', () => {
        pm.configurePlugin('two', false)
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: false })
      })
      it('works with boolean true', () => {
        pm.configurePlugin('two', true)
        expect(Two.prototype.configure).to.have.been.calledWith({ enabled: true })
      })
    })
    describe('with env var true', () => {
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
    it('skips configuring plugins entirely when plugins is false', () => {
      pm.configurePlugin = sinon.spy()
      pm.configure({ plugins: false })
      expect(pm.configurePlugin).not.to.have.been.called
    })
    it('observes configuration options', () => {
      pm.configure({
        serviceMapping: { two: 'deux' },
        logInjection: true,
        queryStringObfuscation: '.*',
        queryStringObfuscationTimeout: 42
      })
      expect(Two.prototype.configure).to.have.been.calledWith({ enabled: true, service: 'deux', logInjection: true })
      expect(Four.prototype.configure).to.have.been.calledWith({
        enabled: true,
        logInjection: true,
        queryStringObfuscation: ':*',
        queryStringObfuscationTimeout: 42
      })
    })
  })

  describe('destroy', () => {
    it('should disable the plugins', () => {
      pm.destroy()
      expect(Two.prototype.configure).to.have.been.calledWith({ enabled: false })
      expect(Four.prototype.configure).to.have.been.calledWith({ enabled: false })
    })
  })
})
