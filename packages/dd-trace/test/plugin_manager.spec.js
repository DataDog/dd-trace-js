'use strict'

const assert = require('node:assert/strict')
const { setImmediate } = require('node:timers/promises')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const { channel } = require('dc-polyfill')
const proxyquire = require('proxyquire')

require('./setup/core')
const Plugin = require('../src/plugins/plugin')

const loadChannel = channel('dd-trace:instrumentation:load')
const partialChannel = channel('dd-trace:test:partial-plugin-activation')
const nomenclature = require('../../dd-trace/src/service-naming')
const log = require('../src/log')
const CompositePlugin = require('../src/plugins/composite')

describe('Plugin Manager', () => {
  let tracer
  let instantiated
  let PluginManager
  let Two
  let Four
  let Five
  let Six
  let Eight
  let Nine
  let Graphql
  let pm
  let registeredDefaults
  let subscriptionCalls
  let constructorError
  let pluginModuleError
  let partialError
  let disableError
  let serviceRunning

  function makeTracerConfig (overrides = {}) {
    return {
      plugins: true,
      spanAttributeSchema: 'v0',
      spanRemoveIntegrationFromService: false,
      // The real tracer Config always carries the testOptimization namespace;
      // #getSharedConfig reads it, so the stand-in must provide it too.
      testOptimization: {},
      tracing: {},
      ...overrides,
    }
  }

  beforeEach(() => {
    constructorError = undefined
    pluginModuleError = undefined
    partialError = undefined
    disableError = undefined
    serviceRunning = false
    tracer = {
      _nomenclature: nomenclature,
    }
    instantiated = []
    subscriptionCalls = 0
    class FakePlugin extends Plugin {
      constructor (aTracer, tracerConfig) {
        super(aTracer, tracerConfig)
        assert.strictEqual(aTracer, tracer)
        instantiated.push(/** @type {{ id: string }} */ (/** @type {unknown} */ (this.constructor)).id)
      }
    }

    const plugins = {
      one: {},
      two: class Two extends FakePlugin {
        static id = 'two'

        constructor (...args) {
          super(...args)
          this.addSub('test:plugin-manager:two', () => subscriptionCalls++)
        }
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
        static optIn = true
        static id = 'eight'
      },
      nine: class Nine extends FakePlugin {
        static id = 'nine'
      },
      ten: class Ten extends FakePlugin {
        static id = 'ten'

        constructor () {
          super(tracer)
          throw constructorError
        }
      },
      partial: class Partial extends Plugin {
        static id = 'partial'

        constructor () {
          super(tracer)
          this.addSub(partialChannel.name, () => {})
        }

        /** @param {boolean | { enabled: boolean }} config */
        configure (config) {
          super.configure(config)
          if (config.enabled) throw partialError
          if (disableError) throw disableError
        }
      },
      composite: class PartialComposite extends CompositePlugin {
        static id = 'composite'
        static plugins = {
          tracing: class Tracing extends Plugin {
            constructor (...args) {
              super(...args)
              serviceRunning = true
            }

            /** @param {boolean | { enabled: boolean }} config */
            configure (config) {
              if (config.enabled === false) serviceRunning = false
              super.configure(config)
            }
          },
        }

        /** @param {boolean | { enabled: boolean }} config */
        configure (config) {
          super.configure(config)
          if (config.enabled) throw partialError
        }
      },
      graphql: class Graphql extends FakePlugin {
        static id = 'graphql'
      },
    }

    Two = plugins.two
    Two.prototype.configure = sinon.spy(Plugin.prototype.configure)
    Four = plugins.four
    Four.prototype.configure = sinon.spy()
    Graphql = plugins.graphql
    Graphql.prototype.configure = sinon.spy()

    // disabled plugins
    Five = plugins.five
    Five.prototype.configure = sinon.spy()
    Six = plugins.six
    Six.prototype.configure = sinon.spy()

    Eight = plugins.eight
    Eight.prototype.configure = sinon.spy()
    Nine = plugins.nine
    Nine.prototype.configure = sinon.spy()

    process.env.DD_TRACE_DISABLED_PLUGINS = 'five,six,seven'

    // Mirrors getValueFromEnvSources: an explicit env value wins, otherwise the registered
    // default is returned unless the caller passes skipDefault. registeredDefaults lets a test
    // model a plugin whose default-enabled flag is `false` (e.g. an opt-in plugin).
    registeredDefaults = {}
    const pluginModules = { ...plugins, '@noCallThru': true }
    Object.defineProperty(pluginModules, 'broken', {
      get () {
        if (pluginModuleError) throw pluginModuleError
        return undefined
      },
    })
    const loadPluginManager = proxyquire.noPreserveCache()
    PluginManager = loadPluginManager('../src/plugin_manager', {
      './plugins': pluginModules,
      '../../datadog-instrumentations': {},
      '../../dd-trace/src/config/helper': {
        getEnvironmentVariable (name) {
          return process.env[name]
        },
        getValueFromEnvSources (name, skipDefault) {
          if (name === 'DD_TRACE_NINE_ENABLED') {
            throw new Error(`${name} is not registered`)
          }
          if (process.env[name] !== undefined) {
            return process.env[name]
          }
          return skipDefault ? undefined : registeredDefaults[name]
        },
        isSupportedConfiguration (name) {
          return name !== 'DD_TRACE_NINE_ENABLED'
        },
      },
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
      pm.configurePlugin('one', false)
    })

    describe('without configure', () => {
      it('should not configure plugins', () => {
        pm.configurePlugin('two')
        loadChannel.publish({ name: 'two' })
        sinon.assert.notCalled(Two.prototype.configure)
      })

      it('should keep the config for future configure calls', () => {
        pm.configurePlugin('two', { foo: 'bar' })
        pm.configure(makeTracerConfig())
        loadChannel.publish({ name: 'two' })
        sinon.assert.calledWithMatch(Two.prototype.configure, {
          enabled: true,
          foo: 'bar',
        })
      })
    })

    describe('without env vars', () => {
      beforeEach(() => pm.configure(makeTracerConfig()))

      it('works with no config param', () => {
        pm.configurePlugin('two')
        loadChannel.publish({ name: 'two' })
        sinon.assert.calledWithMatch(Two.prototype.configure, { enabled: true })
      })

      it('works with empty object config', () => {
        pm.configurePlugin('two', {})
        loadChannel.publish({ name: 'two' })
        sinon.assert.calledWithMatch(Two.prototype.configure, { enabled: true })
      })

      it('works with "enabled: false" object config', () => {
        pm.configurePlugin('two', { enabled: false })
        loadChannel.publish({ name: 'two' })
        sinon.assert.calledWithMatch(Two.prototype.configure, { enabled: false })
      })

      it('works with "enabled: true" object config', () => {
        pm.configurePlugin('two', { enabled: true })
        loadChannel.publish({ name: 'two' })
        sinon.assert.calledWithMatch(Two.prototype.configure, { enabled: true })
      })

      it('works with boolean false', () => {
        pm.configurePlugin('two', false)
        loadChannel.publish({ name: 'two' })
        sinon.assert.calledWithMatch(Two.prototype.configure, { enabled: false })
      })

      it('works with boolean true', () => {
        pm.configurePlugin('two', true)
        loadChannel.publish({ name: 'two' })
        sinon.assert.calledWithMatch(Two.prototype.configure, { enabled: true })
      })
    })

    describe('with disabled plugins', () => {
      beforeEach(() => pm.configure(makeTracerConfig()))

      it('should not call configure on individual enable override', () => {
        pm.configurePlugin('five', { enabled: true })
        loadChannel.publish({ name: 'five' })
        sinon.assert.notCalled(Five.prototype.configure)
      })

      it('should not configure all disabled plugins', () => {
        pm.configure(makeTracerConfig())
        loadChannel.publish({ name: 'five' })
        sinon.assert.notCalled(Five.prototype.configure)
        sinon.assert.notCalled(Six.prototype.configure)
      })
    })

    describe('with env var true', () => {
      beforeEach(() => pm.configure(makeTracerConfig()))

      beforeEach(() => {
        process.env.DD_TRACE_TWO_ENABLED = '1'
      })

      afterEach(() => {
        delete process.env.DD_TRACE_TWO_ENABLED
      })

      it('works with no config param', () => {
        pm.configurePlugin('two')
        loadChannel.publish({ name: 'two' })
        sinon.assert.calledWithMatch(Two.prototype.configure, { enabled: true })
      })

      it('works with empty object config', () => {
        pm.configurePlugin('two', {})
        loadChannel.publish({ name: 'two' })
        sinon.assert.calledWithMatch(Two.prototype.configure, { enabled: true })
      })

      it('works with "enabled: false" object config', () => {
        pm.configurePlugin('two', { enabled: false })
        loadChannel.publish({ name: 'two' })
        sinon.assert.calledWithMatch(Two.prototype.configure, { enabled: false })
      })

      it('works with "enabled: true" object config', () => {
        pm.configurePlugin('two', { enabled: true })
        loadChannel.publish({ name: 'two' })
        sinon.assert.calledWithMatch(Two.prototype.configure, { enabled: true })
      })

      it('works with boolean false', () => {
        pm.configurePlugin('two', false)
        loadChannel.publish({ name: 'two' })
        sinon.assert.calledWithMatch(Two.prototype.configure, { enabled: false })
      })

      it('works with boolean true', () => {
        pm.configurePlugin('two', true)
        loadChannel.publish({ name: 'two' })
        sinon.assert.calledWithMatch(Two.prototype.configure, { enabled: true })
      })
    })

    describe('with env var false', () => {
      beforeEach(() => pm.configure(makeTracerConfig()))

      beforeEach(() => {
        process.env.DD_TRACE_TWO_ENABLED = '0'
      })

      afterEach(() => {
        delete process.env.DD_TRACE_TWO_ENABLED
      })

      it('works with no config param', () => {
        pm.configurePlugin('two')
        loadChannel.publish({ name: 'two' })
        sinon.assert.notCalled(Two.prototype.configure)
      })

      it('works with empty object config', () => {
        pm.configurePlugin('two', {})
        loadChannel.publish({ name: 'two' })
        sinon.assert.notCalled(Two.prototype.configure)
      })

      it('works with "enabled: false" object config', () => {
        pm.configurePlugin('two', { enabled: false })
        loadChannel.publish({ name: 'two' })
        sinon.assert.notCalled(Two.prototype.configure)
      })

      it('works with "enabled: true" object config', () => {
        pm.configurePlugin('two', { enabled: true })
        loadChannel.publish({ name: 'two' })
        sinon.assert.notCalled(Two.prototype.configure)
      })

      it('works with boolean false', () => {
        pm.configurePlugin('two', false)
        loadChannel.publish({ name: 'two' })
        sinon.assert.notCalled(Two.prototype.configure)
      })

      it('works with boolean true', () => {
        pm.configurePlugin('two', true)
        loadChannel.publish({ name: 'two' })
        sinon.assert.notCalled(Two.prototype.configure)
      })
    })
  })

  describe('configure', () => {
    describe('without the load event', () => {
      it('should not instantiate plugins', () => {
        pm.configure(makeTracerConfig())
        pm.configurePlugin('two')
        assert.strictEqual(instantiated.length, 0)
        sinon.assert.notCalled(Two.prototype.configure)
      })
    })

    describe('with an opt-in plugin', () => {
      it('should disable the plugin by default', () => {
        pm.configure(makeTracerConfig())
        loadChannel.publish({ name: 'eight' })
        sinon.assert.calledWithMatch(Eight.prototype.configure, { enabled: false })
      })

      it('should enable the plugin when configured programmatically', () => {
        pm.configure(makeTracerConfig())
        pm.configurePlugin('eight')
        loadChannel.publish({ name: 'eight' })
        sinon.assert.calledWithMatch(Eight.prototype.configure, { enabled: true })
      })

      it('should enable the plugin when configured with an environment variable', () => {
        process.env.DD_TRACE_EIGHT_ENABLED = 'true'
        pm.configure(makeTracerConfig())
        loadChannel.publish({ name: 'eight' })
        sinon.assert.calledWithMatch(Eight.prototype.configure, { enabled: true })
      })

      it('should not hard-disable the plugin when its registered default is false', () => {
        registeredDefaults.DD_TRACE_EIGHT_ENABLED = false
        pm.configure(makeTracerConfig())
        pm.configurePlugin('eight')
        loadChannel.publish({ name: 'eight' })
        sinon.assert.calledWithMatch(Eight.prototype.configure, { enabled: true })
      })
    })

    it('instantiates plugin classes', () => {
      pm.configure(makeTracerConfig())
      loadChannel.publish({ name: 'two' })
      loadChannel.publish({ name: 'four' })
      assert.deepStrictEqual(instantiated, ['two', 'four'])
    })

    it('instantiates a plugin only once for repeated source-file activations', () => {
      pm.configure(makeTracerConfig())
      loadChannel.publish({ name: 'two' })
      loadChannel.publish({ name: 'two' })
      channel('test:plugin-manager:two').publish()

      assert.deepStrictEqual(instantiated, ['two'])
      assert.equal(subscriptionCalls, 1)
    })

    it('ignores load events without a plugin class', () => {
      pm.configure(makeTracerConfig())
      loadChannel.publish({ name: 'one' })
      loadChannel.publish({ name: 'missing' })
      assert.deepStrictEqual(instantiated, [])
    })

    it('contains constructor errors during load activation', async () => {
      constructorError = new Error('constructor failed')
      const errorLog = sinon.stub(log, 'error')
      try {
        pm.configure(makeTracerConfig())
        loadChannel.publish({ name: 'ten' })
        await setImmediate()
        sinon.assert.calledWithExactly(errorLog, 'Error activating plugin %s', 'ten', constructorError)
      } finally {
        errorLog.restore()
      }
    })

    it('contains plugin module load errors during activation', async () => {
      pluginModuleError = new Error('plugin module failed')
      const errorLog = sinon.stub(log, 'error')
      try {
        pm.configure(makeTracerConfig())
        loadChannel.publish({ name: 'broken' })
        await setImmediate()
        sinon.assert.calledWithExactly(errorLog, 'Error activating plugin %s', 'broken', pluginModuleError)
      } finally {
        errorLog.restore()
      }
    })

    it('contains configuration errors during load activation', async () => {
      const error = new Error('configuration failed')
      const errorLog = sinon.stub(log, 'error')
      Two.prototype.configure = sinon.stub()
      Two.prototype.configure.onFirstCall().throws(error)
      try {
        pm.configure(makeTracerConfig())
        loadChannel.publish({ name: 'two' })
        await setImmediate()
        sinon.assert.calledWithExactly(errorLog, 'Error activating plugin %s', 'two', error)
      } finally {
        errorLog.restore()
      }
    })

    it('disables subscriptions after partial activation fails', async () => {
      partialError = new Error('partial activation failed')
      const errorLog = sinon.stub(log, 'error')
      try {
        pm.configure(makeTracerConfig())
        loadChannel.publish({ name: 'partial' })
        await setImmediate()
        assert.strictEqual(partialChannel.hasSubscribers, false)
        sinon.assert.calledWithExactly(errorLog, 'Error activating plugin %s', 'partial', partialError)
      } finally {
        errorLog.restore()
      }
    })

    it('shuts down composite child services after partial activation fails', async () => {
      partialError = new Error('composite activation failed')
      const errorLog = sinon.stub(log, 'error')
      try {
        pm.configure(makeTracerConfig())
        loadChannel.publish({ name: 'composite' })
        await setImmediate()
        assert.strictEqual(serviceRunning, false)
        sinon.assert.calledWithExactly(errorLog, 'Error activating plugin %s', 'composite', partialError)
      } finally {
        errorLog.restore()
      }
    })

    it('reports a failure while disabling a partially activated plugin', async () => {
      partialError = new Error('partial activation failed')
      disableError = new Error('disable failed')
      const errorLog = sinon.stub(log, 'error')
      try {
        pm.configure(makeTracerConfig())
        loadChannel.publish({ name: 'partial' })
        await setImmediate()
        assert.strictEqual(partialChannel.hasSubscribers, false)
        sinon.assert.calledWithExactly(
          errorLog, 'Error disabling plugin %s after failed activation', 'partial', disableError
        )
        sinon.assert.calledWithExactly(errorLog, 'Error activating plugin %s', 'partial', partialError)
      } finally {
        disableError = undefined
        errorLog.restore()
      }
    })

    it('enables plugins without a registered per-plugin flag by default', () => {
      pm.configure(makeTracerConfig())
      loadChannel.publish({ name: 'nine' })
      sinon.assert.calledWithMatch(Nine.prototype.configure, { enabled: true })
    })

    describe('service naming schema manager', () => {
      const config = makeTracerConfig({
        foo: { bar: 1 },
        baz: 2,
      })
      let configureSpy

      beforeEach(() => {
        configureSpy = sinon.spy(tracer._nomenclature, 'configure')
      })

      afterEach(() => {
        configureSpy.restore()
      })

      it('is configured when plugin manager is configured', () => {
        pm.configure(config)
        sinon.assert.calledWith(configureSpy, config)
      })
    })

    it('disables plugins globally when plugins is false', () => {
      pm.configure(makeTracerConfig({ plugins: false }))
      loadChannel.publish({ name: 'two' })
      sinon.assert.calledWithMatch(Two.prototype.configure, { enabled: false })
    })

    it('observes configuration options', () => {
      const tracing = { DD_TRACE_EXPERIMENTAL_EXPORTER: 'jest_worker' }
      pm.configure(makeTracerConfig({
        serviceMapping: { two: 'deux' },
        logInjection: true,
        DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP: '.*',
        DD_TRACE_HTTP_SERVER_OPTIONS_REQUESTS_ENABLED: false,
        clientIpEnabled: true,
        tracing,
      }))
      loadChannel.publish({ name: 'two' })
      loadChannel.publish({ name: 'four' })
      sinon.assert.calledWithMatch(Two.prototype.configure, {
        enabled: true,
        service: 'deux',
        logInjection: true,
        queryStringObfuscation: '.*',
        DD_TRACE_HTTP_SERVER_OPTIONS_REQUESTS_ENABLED: false,
        clientIpEnabled: true,
        tracing,
      })
      sinon.assert.calledWithMatch(Four.prototype.configure, {
        enabled: true,
        logInjection: true,
        queryStringObfuscation: '.*',
        DD_TRACE_HTTP_SERVER_OPTIONS_REQUESTS_ENABLED: false,
        clientIpEnabled: true,
        tracing,
      })
    })

    it('forwards graphql global options to the graphql plugin under their plugin-facing names', () => {
      pm.configure(makeTracerConfig({
        DD_TRACE_GRAPHQL_COLLAPSE: false,
        DD_TRACE_GRAPHQL_DEPTH: 2,
        DD_TRACE_GRAPHQL_VARIABLES: ['foo'],
        DD_TRACE_GRAPHQL_ERROR_EXTENSIONS: ['code'],
      }))
      loadChannel.publish({ name: 'graphql' })
      sinon.assert.calledWithMatch(Graphql.prototype.configure, {
        enabled: true,
        collapse: false,
        depth: 2,
        variables: ['foo'],
        errorExtensions: ['code'],
      })
    })

    it('does not forward graphql options to other plugins', () => {
      pm.configure(makeTracerConfig({ DD_TRACE_GRAPHQL_COLLAPSE: false }))
      loadChannel.publish({ name: 'two' })
      const config = Two.prototype.configure.lastCall.args[0]
      assert.ok(!('collapse' in config))
      assert.ok(!('errorExtensions' in config))
    })
  })

  describe('destroy', () => {
    beforeEach(() => pm.configure(makeTracerConfig()))

    it('should disable the plugins', () => {
      loadChannel.publish({ name: 'two' })
      loadChannel.publish({ name: 'four' })
      pm.destroy()
      sinon.assert.calledWithMatch(Two.prototype.configure, { enabled: false })
      sinon.assert.calledWithMatch(Four.prototype.configure, { enabled: false })
    })
  })
})
