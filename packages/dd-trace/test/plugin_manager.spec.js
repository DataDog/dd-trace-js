'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')
const { channel } = require('dc-polyfill')
const proxyquire = require('proxyquire')

require('./setup/tap')

const loadChannel = channel('dd-trace:instrumentation:load')
const nomenclature = require('../../dd-trace/src/service-naming')

describe('Plugin Manager', () => {
  let tracer
  let instantiated
  let PluginManager
  let Two
  let Four
  let Five
  let Six
  let Eight
  let pm

  beforeEach(() => {
    tracer = {
      _nomenclature: nomenclature
    }
    instantiated = []
    class FakePlugin {
      constructor (aTracer) {
        expect(aTracer).to.equal(tracer)
        instantiated.push(this.constructor.id)
      }
    }

    const plugins = {
      one: {},
      two: class Two extends FakePlugin {
        static id = 'two'
      },
      three: {},
      four: class Four extends FakePlugin {
        static id = 'four'
      },
      five: class Five extends FakePlugin {
        static id = 'five'
      },
      six: class Six extends FakePlugin {
        static id = 'six'
      },
      seven: {},
      eight: class Eight extends FakePlugin {
        static experimental = true
        static id = 'eight'
      }
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

    Eight = plugins.eight
    Eight.prototype.configure = sinon.spy()

    process.env.DD_TRACE_DISABLED_PLUGINS = 'five,six,seven'

    PluginManager = proxyquire.noPreserveCache()('../src/plugin_manager', {
      './plugins': { ...plugins, '@noCallThru': true },
      '../../datadog-instrumentations': {},
      '../../dd-trace/src/config-helper': {
        getEnvironmentVariable (name) {
          return process.env[name]
        }
      }
    })
    pm = new PluginManager(tracer)
  })

  afterEach(() => {
    delete process.env.DD_TRACE_DISABLED_PLUGINS
    delete process.env.DD_TRACE_EIGHT_ENABLED
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
        expect(Two.prototype.configure).to.have.been.calledWithMatch({
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
        expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: true })
      })

      it('works with empty object config', () => {
        pm.configurePlugin('two', {})
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: true })
      })

      it('works with "enabled: false" object config', () => {
        pm.configurePlugin('two', { enabled: false })
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: false })
      })

      it('works with "enabled: true" object config', () => {
        pm.configurePlugin('two', { enabled: true })
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: true })
      })

      it('works with boolean false', () => {
        pm.configurePlugin('two', false)
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: false })
      })

      it('works with boolean true', () => {
        pm.configurePlugin('two', true)
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: true })
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
        expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: true })
      })

      it('works with empty object config', () => {
        pm.configurePlugin('two', {})
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: true })
      })

      it('works with "enabled: false" object config', () => {
        pm.configurePlugin('two', { enabled: false })
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: false })
      })

      it('works with "enabled: true" object config', () => {
        pm.configurePlugin('two', { enabled: true })
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: true })
      })

      it('works with boolean false', () => {
        pm.configurePlugin('two', false)
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: false })
      })

      it('works with boolean true', () => {
        pm.configurePlugin('two', true)
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: true })
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

    describe('with an experimental plugin', () => {
      it('should disable the plugin by default', () => {
        pm.configure()
        loadChannel.publish({ name: 'eight' })
        expect(Eight.prototype.configure).to.have.been.calledWithMatch({ enabled: false })
      })

      it('should enable the plugin when configured programmatically', () => {
        pm.configure()
        pm.configurePlugin('eight')
        loadChannel.publish({ name: 'eight' })
        expect(Eight.prototype.configure).to.have.been.calledWithMatch({ enabled: true })
      })

      it('should enable the plugin when configured with an environment variable', () => {
        process.env.DD_TRACE_EIGHT_ENABLED = 'true'
        pm.configure()
        loadChannel.publish({ name: 'eight' })
        expect(Eight.prototype.configure).to.have.been.calledWithMatch({ enabled: true })
      })
    })

    it('instantiates plugin classes', () => {
      pm.configure()
      loadChannel.publish({ name: 'two' })
      loadChannel.publish({ name: 'four' })
      expect(instantiated).to.deep.equal(['two', 'four'])
    })

    describe('service naming schema manager', () => {
      const config = {
        foo: { bar: 1 },
        baz: 2
      }
      let configureSpy

      beforeEach(() => {
        configureSpy = sinon.spy(tracer._nomenclature, 'configure')
      })

      afterEach(() => {
        configureSpy.restore()
      })

      it('is configured when plugin manager is configured', () => {
        pm.configure(config)
        expect(configureSpy).to.have.been.calledWith(config)
      })
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
        queryStringObfuscation: '.*',
        clientIpEnabled: true
      })
      loadChannel.publish({ name: 'two' })
      loadChannel.publish({ name: 'four' })
      expect(Two.prototype.configure).to.have.been.calledWithMatch({
        enabled: true,
        service: 'deux',
        logInjection: true,
        queryStringObfuscation: '.*',
        clientIpEnabled: true
      })
      expect(Four.prototype.configure).to.have.been.calledWithMatch({
        enabled: true,
        logInjection: true,
        queryStringObfuscation: '.*',
        clientIpEnabled: true
      })
    })
  })

  describe('destroy', () => {
    beforeEach(() => pm.configure())

    it('should disable the plugins', () => {
      loadChannel.publish({ name: 'two' })
      loadChannel.publish({ name: 'four' })
      pm.destroy()
      expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: false })
      expect(Four.prototype.configure).to.have.been.calledWithMatch({ enabled: false })
    })
  })
})
