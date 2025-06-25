'use strict'

const t = require('tap')
require('./setup/core')

const { channel } = require('dc-polyfill')
const proxyquire = require('proxyquire')

const loadChannel = channel('dd-trace:instrumentation:load')
const nomenclature = require('../../dd-trace/src/service-naming')

t.test('Plugin Manager', t => {
  let tracer
  let instantiated
  let PluginManager
  let Two
  let Four
  let Five
  let Six
  let pm

  t.beforeEach(() => {
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
        static get id () {
          return 'two'
        }
      },
      three: {},
      four: class Four extends FakePlugin {
        static get id () {
          return 'four'
        }
      },
      five: class Five extends FakePlugin {
        static get id () {
          return 'five'
        }
      },
      six: class Six extends FakePlugin {
        static get id () {
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
      '../../datadog-instrumentations': {},
      '../../dd-trace/src/config-helper': {
        getEnvironmentVariable (name) {
          return process.env[name]
        }
      }
    })
    pm = new PluginManager(tracer)
  })

  t.afterEach(() => {
    delete process.env.DD_TRACE_DISABLED_PLUGINS
    pm.destroy()
  })

  t.test('configurePlugin', t => {
    t.test('does not throw for old-style plugins', t => {
      expect(() => pm.configurePlugin('one', false)).to.not.throw()
      t.end()
    })

    t.test('without configure', t => {
      t.test('should not configure plugins', t => {
        pm.configurePlugin('two')
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.not.have.been.called
        t.end()
      })

      t.test('should keep the config for future configure calls', t => {
        pm.configurePlugin('two', { foo: 'bar' })
        pm.configure()
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWithMatch({
          enabled: true,
          foo: 'bar'
        })
        t.end()
      })
      t.end()
    })

    t.test('without env vars', t => {
      t.beforeEach(() => pm.configure())

      t.test('works with no config param', t => {
        pm.configurePlugin('two')
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: true })
        t.end()
      })

      t.test('works with empty object config', t => {
        pm.configurePlugin('two', {})
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: true })
        t.end()
      })

      t.test('works with "enabled: false" object config', t => {
        pm.configurePlugin('two', { enabled: false })
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: false })
        t.end()
      })

      t.test('works with "enabled: true" object config', t => {
        pm.configurePlugin('two', { enabled: true })
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: true })
        t.end()
      })

      t.test('works with boolean false', t => {
        pm.configurePlugin('two', false)
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: false })
        t.end()
      })

      t.test('works with boolean true', t => {
        pm.configurePlugin('two', true)
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: true })
        t.end()
      })
      t.end()
    })

    t.test('with disabled plugins', t => {
      t.beforeEach(() => pm.configure())

      t.test('should not call configure on individual enable override', t => {
        pm.configurePlugin('five', { enabled: true })
        loadChannel.publish({ name: 'five' })
        expect(Five.prototype.configure).to.not.have.been.called
        t.end()
      })

      t.test('should not configure all disabled plugins', t => {
        pm.configure({})
        loadChannel.publish({ name: 'five' })
        expect(Five.prototype.configure).to.not.have.been.called
        expect(Six.prototype.configure).to.not.have.been.called
        t.end()
      })
      t.end()
    })

    t.test('with env var true', t => {
      t.beforeEach(() => pm.configure())

      t.beforeEach(() => {
        process.env.DD_TRACE_TWO_ENABLED = '1'
      })

      t.afterEach(() => {
        delete process.env.DD_TRACE_TWO_ENABLED
      })

      t.test('works with no config param', t => {
        pm.configurePlugin('two')
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: true })
        t.end()
      })

      t.test('works with empty object config', t => {
        pm.configurePlugin('two', {})
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: true })
        t.end()
      })

      t.test('works with "enabled: false" object config', t => {
        pm.configurePlugin('two', { enabled: false })
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: false })
        t.end()
      })

      t.test('works with "enabled: true" object config', t => {
        pm.configurePlugin('two', { enabled: true })
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: true })
        t.end()
      })

      t.test('works with boolean false', t => {
        pm.configurePlugin('two', false)
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: false })
        t.end()
      })

      t.test('works with boolean true', t => {
        pm.configurePlugin('two', true)
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: true })
        t.end()
      })
      t.end()
    })

    t.test('with env var false', t => {
      t.beforeEach(() => pm.configure())

      t.beforeEach(() => {
        process.env.DD_TRACE_TWO_ENABLED = '0'
      })

      t.afterEach(() => {
        delete process.env.DD_TRACE_TWO_ENABLED
      })

      t.test('works with no config param', t => {
        pm.configurePlugin('two')
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.not.have.been.called
        t.end()
      })

      t.test('works with empty object config', t => {
        pm.configurePlugin('two', {})
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.not.have.been.called
        t.end()
      })

      t.test('works with "enabled: false" object config', t => {
        pm.configurePlugin('two', { enabled: false })
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.not.have.been.called
        t.end()
      })

      t.test('works with "enabled: true" object config', t => {
        pm.configurePlugin('two', { enabled: true })
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.not.have.been.called
        t.end()
      })

      t.test('works with boolean false', t => {
        pm.configurePlugin('two', false)
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.not.have.been.called
        t.end()
      })

      t.test('works with boolean true', t => {
        pm.configurePlugin('two', true)
        loadChannel.publish({ name: 'two' })
        expect(Two.prototype.configure).to.not.have.been.called
        t.end()
      })
      t.end()
    })
    t.end()
  })

  t.test('configure', t => {
    t.test('without the load event', t => {
      t.test('should not instantiate plugins', t => {
        pm.configure()
        pm.configurePlugin('two')
        expect(instantiated).to.be.empty
        expect(Two.prototype.configure).to.not.have.been.called
        t.end()
      })
      t.end()
    })

    t.test('instantiates plugin classes', t => {
      pm.configure()
      loadChannel.publish({ name: 'two' })
      loadChannel.publish({ name: 'four' })
      expect(instantiated).to.deep.equal(['two', 'four'])
      t.end()
    })

    t.test('service naming schema manager', t => {
      const config = {
        foo: { bar: 1 },
        baz: 2
      }
      let configureSpy

      t.beforeEach(() => {
        configureSpy = sinon.spy(tracer._nomenclature, 'configure')
      })

      t.afterEach(() => {
        configureSpy.restore()
      })

      t.test('is configured when plugin manager is configured', t => {
        pm.configure(config)
        expect(configureSpy).to.have.been.calledWith(config)
        t.end()
      })
      t.end()
    })

    t.test('skips configuring plugins entirely when plugins is false', t => {
      pm.configurePlugin = sinon.spy()
      pm.configure({ plugins: false })
      expect(pm.configurePlugin).not.to.have.been.called
      t.end()
    })

    t.test('observes configuration options', t => {
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
      t.end()
    })
    t.end()
  })

  t.test('destroy', t => {
    t.beforeEach(() => pm.configure())

    t.test('should disable the plugins', t => {
      loadChannel.publish({ name: 'two' })
      loadChannel.publish({ name: 'four' })
      pm.destroy()
      expect(Two.prototype.configure).to.have.been.calledWithMatch({ enabled: false })
      expect(Four.prototype.configure).to.have.been.calledWithMatch({ enabled: false })
      t.end()
    })
    t.end()
  })
  t.end()
})
