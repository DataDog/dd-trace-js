'use strict'

const assert = require('node:assert/strict')

const { describe, it, before, after, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const { channel } = require('dc-polyfill')
const proxyquire = require('proxyquire')

require('./setup/core')

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
  let Fs
  let Graphql
  let AwsLambda
  let pm
  let registeredDefaults

  function makeTracerConfig (overrides = {}) {
    return {
      plugins: true,
      spanAttributeSchema: 'v0',
      spanRemoveIntegrationFromService: false,
      // The real tracer Config always carries the testOptimization namespace;
      // #getSharedConfig reads it, so the stand-in must provide it too.
      testOptimization: {},
      ...overrides,
    }
  }

  beforeEach(() => {
    tracer = {
      _nomenclature: nomenclature,
    }
    instantiated = []
    class FakePlugin {
      constructor (aTracer) {
        assert.strictEqual(aTracer, tracer)
        instantiated.push(/** @type {{ id: string }} */ (/** @type {unknown} */ (this.constructor)).id)
      }

      configure () {}
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
      },
      fs: class Fs extends FakePlugin {
        static id = 'fs'
      },
      graphql: class Graphql extends FakePlugin {
        static id = 'graphql'
      },
      'aws-lambda': class AwsLambda extends FakePlugin {
        static id = 'aws-lambda'
      },
    }

    Two = plugins.two
    Two.prototype.configure = sinon.spy()
    Four = plugins.four
    Four.prototype.configure = sinon.spy()
    Graphql = plugins.graphql
    Graphql.prototype.configure = sinon.spy()
    AwsLambda = plugins['aws-lambda']
    AwsLambda.prototype.configure = sinon.spy()

    // disabled plugins
    Five = plugins.five
    Five.prototype.configure = sinon.spy()
    Six = plugins.six
    Six.prototype.configure = sinon.spy()

    Eight = plugins.eight
    Eight.prototype.configure = sinon.spy()
    Fs = plugins.fs
    Fs.prototype.configure = sinon.spy()

    if (process.env.AWS_LAMBDA_FUNCTION_NAME === undefined) {
      process.env.DD_TRACE_DISABLED_PLUGINS = 'five,six,seven'
    }

    // Mirrors getValueFromEnvSources: an explicit env value wins, otherwise the registered
    // default is returned unless the caller passes skipDefault. registeredDefaults lets a test
    // model a plugin whose default-enabled flag is `false` (e.g. an experimental plugin).
    registeredDefaults = {}
    PluginManager = proxyquire.noPreserveCache()('../src/plugin_manager', {
      './plugins': { ...plugins, '@noCallThru': true },
      './lambda': {},
      '../../datadog-instrumentations': {},
      '../../dd-trace/src/config/helper': {
        getEnvironmentVariable (name) {
          return process.env[name]
        },
        getValueFromEnvSources (name, skipDefault) {
          if (process.env[name] !== undefined) {
            return process.env[name]
          }
          return skipDefault ? undefined : registeredDefaults[name]
        },
      },
    })
    pm = new PluginManager(tracer)
  })

  afterEach(() => {
    delete process.env.DD_TRACE_DISABLED_PLUGINS
    delete process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS
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
    describe('in an AWS Lambda environment', () => {
      before(() => {
        process.env.AWS_LAMBDA_FUNCTION_NAME = 'test-function'
      })

      after(() => {
        delete process.env.AWS_LAMBDA_FUNCTION_NAME
      })

      it('registers the aws-lambda plugin without a module-load event', () => {
        pm.configure(makeTracerConfig())

        assert.deepStrictEqual(instantiated, ['aws-lambda'])
        sinon.assert.calledWithMatch(AwsLambda.prototype.configure, { enabled: true })
      })

      it('forwards the centralized Lambda namespace and shared tracer settings', () => {
        pm.configure(makeTracerConfig({
          DD_API_KEY: 'api-key',
          DD_APM_FLUSH_DEADLINE_MILLISECONDS: 25,
          DD_TRACE_AWS_ADD_SPAN_POINTERS: true,
          dsmEnabled: true,
          lambda: {
            enhancedMetrics: false,
            fipsMode: true,
          },
          logInjection: false,
          site: 'datadoghq.eu',
        }))

        sinon.assert.calledWithMatch(AwsLambda.prototype.configure, {
          addSpanPointers: true,
          apiKey: 'api-key',
          apmFlushDeadlineMs: 25,
          dataStreamsEnabled: true,
          enhancedMetrics: false,
          fipsMode: true,
          logInjection: false,
          site: 'datadoghq.eu',
        })
      })

      it('applies the Lambda fs default when no disabled-plugin list was supplied', () => {
        pm.configure(makeTracerConfig())
        loadChannel.publish({ name: 'fs' })

        assert.deepStrictEqual(instantiated, ['aws-lambda'])
        sinon.assert.notCalled(Fs.prototype.configure)
      })

      it('preserves the lambda disabled-instrumentation alias', () => {
        process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS = 'http, lambda'
        pm.configure(makeTracerConfig())

        assert.deepStrictEqual(instantiated, [])
        sinon.assert.notCalled(AwsLambda.prototype.configure)
        delete process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS
      })
    })

    describe('without the load event', () => {
      it('should not instantiate plugins', () => {
        pm.configure(makeTracerConfig())
        pm.configurePlugin('two')
        assert.strictEqual(instantiated.length, 0)
        sinon.assert.notCalled(Two.prototype.configure)
      })
    })

    describe('with an experimental plugin', () => {
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
      pm.configure(makeTracerConfig({
        serviceMapping: { two: 'deux' },
        logInjection: true,
        DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP: '.*',
        clientIpEnabled: true,
      }))
      loadChannel.publish({ name: 'two' })
      loadChannel.publish({ name: 'four' })
      sinon.assert.calledWithMatch(Two.prototype.configure, {
        enabled: true,
        service: 'deux',
        logInjection: true,
        queryStringObfuscation: '.*',
        clientIpEnabled: true,
      })
      sinon.assert.calledWithMatch(Four.prototype.configure, {
        enabled: true,
        logInjection: true,
        queryStringObfuscation: '.*',
        clientIpEnabled: true,
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
