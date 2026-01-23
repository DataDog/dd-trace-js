'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('./setup/core')

describe('TracerProxy', () => {
  let Proxy
  let proxy
  let DatadogTracer
  let NoopTracer
  let AIGuardSdk
  let NoopAIGuardSdk
  let AppsecSdk
  let NoopAppsecSdk
  let tracer
  let NoopProxy
  let noop
  let aiguardSdk
  let noopAiguardSdk
  let appsecSdk
  let noopAppsecSdk
  let Config
  let config
  let runtimeMetrics
  let log
  let profiler
  let appsec
  let telemetry
  let iast
  let openfeature
  let PluginManager
  let pluginManager
  let flare
  let RemoteConfig
  let handlers
  let rc
  let dogStatsD
  let noopDogStatsDClient
  let NoopDogStatsDClient
  let OpenFeatureProvider
  let openfeatureProvider

  beforeEach(() => {
    process.env.DD_TRACE_MOCHA_ENABLED = 'false'

    aiguardSdk = {
      evaluate: sinon.stub(),
    }

    appsecSdk = {
      trackUserLoginSuccessEvent: sinon.stub(),
      trackUserLoginFailureEvent: sinon.stub(),
      trackCustomEvent: sinon.stub()
    }

    pluginManager = {
      configure: sinon.spy()
    }

    tracer = {
      use: sinon.stub().returns('tracer'),
      trace: sinon.stub().returns('test'),
      wrap: sinon.stub().returns('fn'),
      startSpan: sinon.stub().returns('span'),
      inject: sinon.stub().returns('tracer'),
      extract: sinon.stub().returns('spanContext'),
      setUrl: sinon.stub(),
      configure: sinon.spy()
    }

    noop = {
      use: sinon.stub().returns('tracer'),
      trace: sinon.stub().returns('test'),
      wrap: sinon.stub().returns('fn'),
      startSpan: sinon.stub().returns('span'),
      inject: sinon.stub().returns('noop'),
      extract: sinon.stub().returns('spanContext'),
      setUrl: sinon.stub(),
      configure: sinon.spy()
    }

    noopAiguardSdk = {
      evaluate: sinon.stub(),
    }

    noopAppsecSdk = {
      trackUserLoginSuccessEvent: sinon.stub(),
      trackUserLoginFailureEvent: sinon.stub(),
      trackCustomEvent: sinon.stub()
    }

    noopDogStatsDClient = {
      increment: sinon.spy(),
      decrement: sinon.spy(),
      gauge: sinon.spy(),
      distribution: sinon.spy(),
      histogram: sinon.spy(),
      flush: sinon.spy()
    }

    {
      const dogstatsdIncrements = []
      let dogstatsdConfig
      let dogstatsdFlushes = 0

      class FauxDogStatsDClient {
        constructor (cfg) {
          dogstatsdConfig = cfg
        }

        increment () {
          dogstatsdIncrements.push(arguments)
        }

        flush () {
          dogstatsdFlushes++
        }
      }

      dogStatsD = {
        CustomMetrics: FauxDogStatsDClient,
        _increments: () => dogstatsdIncrements,
        _config: () => dogstatsdConfig,
        _flushes: () => dogstatsdFlushes
      }
    }

    log = {
      error: sinon.spy()
    }

    DatadogTracer = sinon.stub().returns(tracer)
    NoopTracer = sinon.stub().returns(noop)
    AIGuardSdk = sinon.stub().returns(aiguardSdk)
    NoopAIGuardSdk = sinon.stub().returns(noopAiguardSdk)
    AppsecSdk = sinon.stub().returns(appsecSdk)
    NoopAppsecSdk = sinon.stub().returns(noopAppsecSdk)
    PluginManager = sinon.stub().returns(pluginManager)
    NoopDogStatsDClient = sinon.stub().returns(noopDogStatsDClient)

    config = {
      tracing: true,
      experimental: {
        flaggingProvider: {},
        aiguard: {
          enabled: true
        }
      },
      injectionEnabled: [],
      logger: 'logger',
      debug: true,
      profiling: {},
      apmTracingEnabled: false,
      appsec: {},
      iast: {},
      crashtracking: {},
      dynamicInstrumentation: {},
      remoteConfig: {
        enabled: true
      },
      runtimeMetrics: {
        enabled: false
      },
      setRemoteConfig: sinon.spy(),
      llmobs: {},
      heapSnapshot: {}
    }
    Config = sinon.stub().returns(config)

    runtimeMetrics = {
      start: sinon.spy()
    }

    profiler = {
      start: sinon.spy()
    }

    appsec = {
      enable: sinon.spy(),
      disable: sinon.spy()
    }

    telemetry = {
      start: sinon.spy()
    }

    iast = {
      enable: sinon.spy(),
      disable: sinon.spy()
    }

    openfeature = {
      enable: sinon.spy(),
      disable: sinon.spy()
    }

    openfeatureProvider = {
      _setConfiguration: sinon.spy()
    }

    OpenFeatureProvider = sinon.stub().returns(openfeatureProvider)

    flare = {
      enable: sinon.spy(),
      disable: sinon.spy(),
      prepare: sinon.spy(),
      send: sinon.spy(),
      cleanup: sinon.spy()
    }

    handlers = new Map()
    rc = {
      setProductHandler (product, handler) { handlers.set(product, handler) },
      removeProductHandler (product) { handlers.delete(product) },
      updateCapabilities: sinon.spy(),
      setBatchHandler (products, handler) {
        for (const product of products) {
          handlers.set(product, handler)
        }
      },
      removeBatchHandler: sinon.spy(),
      subscribeProducts: sinon.spy(),
      unsubscribeProducts: sinon.spy()
    }

    RemoteConfig = sinon.stub().returns(rc)

    NoopProxy = proxyquire('../src/noop/proxy', {
      './tracer': NoopTracer,
      '../aiguard/noop': NoopAIGuardSdk,
      '../appsec/sdk/noop': NoopAppsecSdk,
      './dogstatsd': NoopDogStatsDClient
    })

    Proxy = proxyquire('../src/proxy', {
      './tracer': DatadogTracer,
      './noop/proxy': NoopProxy,
      './config': Config,
      './plugin_manager': PluginManager,
      './runtime_metrics': runtimeMetrics,
      './log': log,
      './profiler': profiler,
      './appsec': appsec,
      './appsec/iast': iast,
      './telemetry': telemetry,
      './remote_config': RemoteConfig,
      './aiguard/sdk': AIGuardSdk,
      './appsec/sdk': AppsecSdk,
      './dogstatsd': dogStatsD,
      './noop/dogstatsd': NoopDogStatsDClient,
      './flare': flare,
      './openfeature': openfeature,
      './openfeature/flagging_provider': OpenFeatureProvider
    })

    proxy = new Proxy()
  })

  describe('uninitialized', () => {
    describe('init', () => {
      it('should return itself', () => {
        assert.strictEqual(proxy.init(), proxy)
      })

      it('should initialize and configure an instance of DatadogTracer', () => {
        const options = {}

        proxy.init(options)

        sinon.assert.calledWith(Config, options)
        sinon.assert.calledWith(DatadogTracer, config)
        sinon.assert.calledOnceWithExactly(RemoteConfig, config)
      })

      it('should not initialize twice', () => {
        proxy.init()
        proxy.init()

        sinon.assert.calledOnce(DatadogTracer)
        sinon.assert.calledOnce(RemoteConfig)
      })

      it('should not enable remote config when disabled', () => {
        config.remoteConfig.enabled = false

        proxy.init()

        sinon.assert.calledOnce(DatadogTracer)
        sinon.assert.notCalled(RemoteConfig)
      })

      it('should not initialize when disabled', () => {
        config.tracing = false

        proxy.init()

        sinon.assert.notCalled(DatadogTracer)
      })

      it('should not capture runtimeMetrics by default', () => {
        proxy.init()

        sinon.assert.notCalled(runtimeMetrics.start)
      })

      it('should support applying remote config', () => {
        const conf = {}

        proxy.init()

        handlers.get('APM_TRACING')(createApmTracingTransaction('test-config', conf))

        sinon.assert.calledWith(config.setRemoteConfig, conf)
        sinon.assert.calledWith(tracer.configure, config)
        sinon.assert.calledWith(pluginManager.configure, config)
      })

      it('should support enabling debug logs for tracer flares', () => {
        const logLevel = 'debug'

        proxy.init()

        handlers.get('AGENT_CONFIG')('apply', {
          config: {
            log_level: logLevel
          },
          name: 'flare-log-level.debug'
        })

        sinon.assert.calledWith(flare.enable, config)
        sinon.assert.calledWith(flare.prepare, logLevel)
      })

      it('should support sending tracer flares', () => {
        const task = {
          case_id: '111',
          hostname: 'myhostname',
          user_handle: 'user.name@datadoghq.com'
        }

        proxy.init()

        handlers.get('AGENT_TASK')('apply', {
          args: task,
          task_type: 'tracer_flare',
          uuid: 'd53fc8a4-8820-47a2-aa7d-d565582feb81'
        })

        sinon.assert.calledWith(flare.enable, config)
        sinon.assert.calledWith(flare.send, task)
      })

      it('should cleanup flares when the config is removed', () => {
        const conf = {
          config: {
            log_level: 'debug'
          },
          name: 'flare-log-level.debug'
        }

        proxy.init()

        handlers.get('AGENT_CONFIG')('apply', conf)
        handlers.get('AGENT_CONFIG')('unapply', conf)

        sinon.assert.called(flare.disable)
      })

      it('should setup FFE_FLAGS product handler when openfeature provider is enabled', () => {
        config.experimental.flaggingProvider.enabled = true

        proxy.init()
        proxy.openfeature // Trigger lazy loading

        const flagConfig = { flags: { 'test-flag': {} } }
        handlers.get('FFE_FLAGS')('apply', flagConfig)

        sinon.assert.calledWith(openfeatureProvider._setConfiguration, flagConfig)
      })

      it('should handle FFE_FLAGS modify action', () => {
        config.experimental.flaggingProvider.enabled = true

        proxy.init()
        proxy.openfeature // Trigger lazy loading

        const flagConfig = { flags: { 'modified-flag': {} } }
        handlers.get('FFE_FLAGS')('modify', flagConfig)

        sinon.assert.calledWith(openfeatureProvider._setConfiguration, flagConfig)
      })

      it('should support applying remote config', () => {
        const RemoteConfigProxy = proxyquire('../src/proxy', {
          './tracer': DatadogTracer,
          './appsec': appsec,
          './appsec/iast': iast,
          './remote_config': RemoteConfig,
          './appsec/sdk': AppsecSdk
        })

        const remoteConfigProxy = new RemoteConfigProxy()
        remoteConfigProxy.init()
        remoteConfigProxy.appsec // Eagerly trigger lazy loading.
        sinon.assert.calledOnce(DatadogTracer)
        sinon.assert.calledOnce(AppsecSdk)
        sinon.assert.notCalled(appsec.enable)
        sinon.assert.notCalled(iast.enable)

        let conf = { tracing_enabled: false }
        handlers.get('APM_TRACING')(createApmTracingTransaction('test-config-1', conf))
        sinon.assert.notCalled(appsec.disable)
        sinon.assert.notCalled(iast.disable)

        conf = { tracing_enabled: true }
        handlers.get('APM_TRACING')(createApmTracingTransaction('test-config-1', conf, 'modify'))
        sinon.assert.calledOnce(DatadogTracer)
        sinon.assert.calledOnce(AppsecSdk)
        sinon.assert.notCalled(appsec.enable)
        sinon.assert.notCalled(iast.enable)
      })

      it('should support applying remote config (only call disable if enabled before)', () => {
        const RemoteConfigProxy = proxyquire('../src/proxy', {
          './tracer': DatadogTracer,
          './config': Config,
          './appsec': appsec,
          './appsec/iast': iast,
          './remote_config': RemoteConfig,
          './appsec/sdk': AppsecSdk
        })

        config.telemetry = {}
        config.appsec.enabled = true
        config.iast.enabled = true
        config.setRemoteConfig = conf => {
          config.tracing = conf.tracing_enabled
        }

        const remoteConfigProxy = new RemoteConfigProxy()
        remoteConfigProxy.init()

        sinon.assert.calledOnceWithExactly(appsec.enable, config)
        sinon.assert.calledOnceWithExactly(iast.enable, config, tracer)

        let conf = { tracing_enabled: false }
        handlers.get('APM_TRACING')(createApmTracingTransaction('test-config-2', conf))
        sinon.assert.called(appsec.disable)
        sinon.assert.called(iast.disable)

        conf = { tracing_enabled: true }
        handlers.get('APM_TRACING')(createApmTracingTransaction('test-config-2', conf, 'modify'))
        sinon.assert.calledTwice(appsec.enable)
        sinon.assert.calledWithExactly(appsec.enable.secondCall, config)
        sinon.assert.calledTwice(iast.enable)
        sinon.assert.calledWithExactly(iast.enable.secondCall, config, tracer)
      })

      it('should start capturing runtimeMetrics when configured', () => {
        config.runtimeMetrics.enabled = true

        proxy.init()

        sinon.assert.called(runtimeMetrics.start)
      })

      it('should expose noop metrics methods prior to initialization', () => {
        proxy.dogstatsd.increment('foo')
      })

      it('should expose noop metrics methods after init when unconfigured', () => {
        config.dogstatsd = null

        proxy.init()

        proxy.dogstatsd.increment('foo')
      })

      it('should expose real metrics methods after init when configured', () => {
        config.dogstatsd = {
          hostname: 'localhost',
          port: 9876
        }
        config.tags = {
          service: 'photos',
          env: 'prod',
          version: '1.2.3'
        }

        proxy.init()
        proxy.dogstatsd.increment('foo', 10, { alpha: 'bravo' })

        const incs = dogStatsD._increments()

        assert.strictEqual(dogStatsD._config().dogstatsd.hostname, 'localhost')
        assert.strictEqual(incs.length, 1)
        assert.strictEqual(incs[0][0], 'foo')
        assert.strictEqual(incs[0][1], 10)
        assert.deepStrictEqual(incs[0][2], { alpha: 'bravo' })
      })

      it('should enable appsec when explicitly configured to true', () => {
        config.appsec = { enabled: true }

        proxy.init()

        sinon.assert.called(appsec.enable)
      })

      it('should not enable appsec when explicitly configured to false', () => {
        config.appsec = { enabled: false }

        proxy.init()

        sinon.assert.notCalled(appsec.enable)
      })

      it('should enable iast when configured', () => {
        config.iast = { enabled: true }

        proxy.init()

        sinon.assert.calledOnce(iast.enable)
      })

      it('should not enable iast when it is not configured', () => {
        config.iast = {}

        proxy.init()

        sinon.assert.notCalled(iast.enable)
      })

      it('should not load the profiler when not configured', () => {
        config.profiling = { enabled: false }

        proxy.init()

        sinon.assert.notCalled(profiler.start)
      })

      it('should not load the profiler when profiling config does not exist', () => {
        config.pro_fil_ing = 'invalidConfig'

        proxy.init()

        sinon.assert.notCalled(profiler.start)
      })

      it('should load profiler when configured', () => {
        config.profiling = { enabled: 'true' }

        proxy.init()

        sinon.assert.called(profiler.start)
      })

      it('should throw an error since profiler fails to be imported', () => {
        config.profiling = { enabled: 'true' }

        const ProfilerImportFailureProxy = proxyquire('../src/proxy', {
          './tracer': DatadogTracer,
          './noop/tracer': NoopTracer,
          './config': Config,
          './runtime_metrics': runtimeMetrics,
          './log': log,
          './profiler': null, // this will cause the import failure error
          './appsec': appsec,
          './telemetry': telemetry,
          './remote_config': RemoteConfig
        })

        const profilerImportFailureProxy = new ProfilerImportFailureProxy()
        profilerImportFailureProxy.init()

        sinon.assert.calledOnce(log.error)
        const expectedErr = sinon.match.instanceOf(Error).and(sinon.match.has('code', 'MODULE_NOT_FOUND'))
        sinon.assert.match(log.error.firstCall.lastArg, sinon.match(expectedErr))
      })

      it('should start telemetry', () => {
        proxy.init()

        sinon.assert.called(telemetry.start)
      })

      it('should configure standalone', () => {
        const standalone = {
          configure: sinon.stub()
        }

        const options = {}
        const DatadogProxy = proxyquire('../src/proxy', {
          './tracer': DatadogTracer,
          './config': Config,
          './appsec': appsec,
          './appsec/iast': iast,
          './remote_config': RemoteConfig,
          './appsec/sdk': AppsecSdk,
          './standalone': standalone,
          './telemetry': telemetry
        })

        const proxy = new DatadogProxy()
        proxy.init(options)
        proxy.appsec // Eagerly trigger lazy loading.

        const config = AppsecSdk.firstCall.args[1]
        sinon.assert.calledOnceWithExactly(standalone.configure, config)
      })
    })

    describe('trace', () => {
      it('should call the underlying NoopTracer', () => {
        const callback = () => 'test'
        const returnValue = proxy.trace('a', 'b', callback)

        sinon.assert.calledWith(noop.trace, 'a', 'b', callback)
        assert.strictEqual(returnValue, 'test')
      })

      it('should work without options', () => {
        const callback = () => 'test'
        const returnValue = proxy.trace('a', callback)

        sinon.assert.calledWith(noop.trace, 'a', {}, callback)
        assert.strictEqual(returnValue, 'test')
      })

      it('should ignore calls without an invalid callback', () => {
        proxy.wrap('a', 'b')

        sinon.assert.notCalled(noop.trace)
      })
    })

    describe('wrap', () => {
      it('should call the underlying NoopTracer', () => {
        const callback = () => 'test'
        const returnValue = proxy.wrap('a', 'b', callback)

        sinon.assert.calledWith(noop.wrap, 'a', 'b', callback)
        assert.strictEqual(returnValue, 'fn')
      })

      it('should work without options', () => {
        const callback = () => 'test'
        const returnValue = proxy.wrap('a', callback)

        sinon.assert.calledWith(noop.wrap, 'a', {}, callback)
        assert.strictEqual(returnValue, 'fn')
      })

      it('should ignore calls without an invalid callback', () => {
        const returnValue = proxy.wrap('a', 'b')

        sinon.assert.notCalled(noop.wrap)
        assert.strictEqual(returnValue, 'b')
      })
    })

    describe('startSpan', () => {
      it('should call the underlying NoopTracer', () => {
        const returnValue = proxy.startSpan('a', 'b', 'c')

        sinon.assert.calledWith(noop.startSpan, 'a', 'b', 'c')
        assert.strictEqual(returnValue, 'span')
      })
    })

    describe('inject', () => {
      it('should call the underlying NoopTracer', () => {
        const returnValue = proxy.inject('a', 'b', 'c')

        sinon.assert.calledWith(noop.inject, 'a', 'b', 'c')
        assert.strictEqual(returnValue, 'noop')
      })
    })

    describe('extract', () => {
      it('should call the underlying NoopTracer', () => {
        const returnValue = proxy.extract('a', 'b', 'c')

        sinon.assert.calledWith(noop.extract, 'a', 'b', 'c')
        assert.strictEqual(returnValue, 'spanContext')
      })
    })

    describe('setUrl', () => {
      it('should call the underlying DatadogTracer', () => {
        const returnValue = proxy.setUrl('http://example.com')

        sinon.assert.calledWith(noop.setUrl, 'http://example.com')
        assert.strictEqual(returnValue, proxy)
      })
    })

    describe('baggage', () => {
      afterEach(() => {
        proxy.removeAllBaggageItems()
      })

      describe('setBaggageItem', () => {
        it('should set a baggage item', () => {
          const baggage = proxy.setBaggageItem('key', 'value')
          assert.deepStrictEqual(baggage, { key: 'value' })
        })

        it('should merge with existing baggage items', () => {
          proxy.setBaggageItem('key1', 'value1')
          const baggage = proxy.setBaggageItem('key2', 'value2')
          assert.deepStrictEqual(baggage, { key1: 'value1', key2: 'value2' })
        })

        it('should ignore invalid key or value', () => {
          proxy.setBaggageItem(null, 'value')
          proxy.setBaggageItem(123, 'value')

          // Valid
          proxy.setBaggageItem('key1', 'value1')

          proxy.setBaggageItem('key2', 333)
          const baggage = proxy.setBaggageItem('key3', {})

          assert.deepStrictEqual(baggage, { key1: 'value1' })
        })
      })

      describe('getBaggageItem', () => {
        it('should get a baggage item', () => {
          proxy.setBaggageItem('key', 'value')
          assert.strictEqual(proxy.getBaggageItem('key'), 'value')
        })

        it('should return undefined for non-existent items', () => {
          assert.strictEqual(proxy.getBaggageItem('missing'), undefined)
        })
      })

      describe('getAllBaggageItems', () => {
        it('should get all baggage items', () => {
          proxy.setBaggageItem('key1', 'value1')
          proxy.setBaggageItem('key2', 'value2')
          assert.deepStrictEqual(proxy.getAllBaggageItems(), { key1: 'value1', key2: 'value2' })
        })

        it('should return empty object when no items exist', () => {
          assert.deepStrictEqual(proxy.getAllBaggageItems(), {})
        })
      })

      describe('removeBaggageItem', () => {
        it('should remove a specific baggage item', () => {
          proxy.setBaggageItem('key1', 'value1')
          proxy.setBaggageItem('key2', 'value2')
          const baggage = proxy.removeBaggageItem('key1')
          assert.deepStrictEqual(baggage, { key2: 'value2' })
        })

        it('should handle removing non-existent items', () => {
          proxy.setBaggageItem('key', 'value')
          const baggage = proxy.removeBaggageItem('missing')
          assert.deepStrictEqual(baggage, { key: 'value' })
        })
      })

      describe('removeAllBaggageItems', () => {
        it('should remove all baggage items', () => {
          proxy.setBaggageItem('key1', 'value1')
          proxy.setBaggageItem('key2', 'value2')
          const baggage = proxy.removeAllBaggageItems()
          assert.deepStrictEqual(baggage, {})
        })
      })
    })

    describe('appsec', () => {
      describe('trackUserLoginSuccessEvent', () => {
        it('should call the underlying NoopAppsecSdk method', () => {
          const user = { id: 'user_id' }
          const metadata = { metakey1: 'metavalue1' }
          proxy.appsec.trackUserLoginSuccessEvent(user, metadata)
          sinon.assert.calledOnceWithExactly(noopAppsecSdk.trackUserLoginSuccessEvent, user, metadata)
        })
      })

      describe('trackUserLoginFailureEvent', () => {
        it('should call the underlying NoopAppsecSdk method', () => {
          const userId = 'user_id'
          const exists = true
          const metadata = { metakey1: 'metavalue1' }
          proxy.appsec.trackUserLoginFailureEvent(userId, exists, metadata)
          sinon.assert.calledOnceWithExactly(noopAppsecSdk.trackUserLoginFailureEvent, userId, exists, metadata)
        })
      })

      describe('trackCustomEvent', () => {
        it('should call the underlying NoopAppsecSdk method', () => {
          const eventName = 'custom_event'
          const metadata = { metakey1: 'metavalue1' }
          proxy.appsec.trackCustomEvent(eventName, metadata)
          sinon.assert.calledOnceWithExactly(noopAppsecSdk.trackCustomEvent, eventName, metadata)
        })
      })
    })

    describe('dogstatsd', () => {
      it('should not throw when calling noop methods', () => {
        proxy.dogstatsd.increment('inc')
        sinon.assert.calledWith(noopDogStatsDClient.increment, 'inc')
        proxy.dogstatsd.decrement('dec')
        sinon.assert.calledWith(noopDogStatsDClient.decrement, 'dec')
        proxy.dogstatsd.distribution('dist')
        sinon.assert.calledWith(noopDogStatsDClient.distribution, 'dist')
        proxy.dogstatsd.histogram('hist')
        sinon.assert.calledWith(noopDogStatsDClient.histogram, 'hist')
        proxy.dogstatsd.flush()
        sinon.assert.called(noopDogStatsDClient.flush)
      })
    })
  })

  describe('aiguard', () => {
    describe('evaluate', () => {
      it('should call the underlying NoopAIGuardSdk method', () => {
        const messages = [{ role: 'user', content: 'What day is today?' }]
        proxy.aiguard.evaluate(messages)
        sinon.assert.calledOnceWithExactly(noopAiguardSdk.evaluate, messages)
      })
    })
  })

  describe('initialized', () => {
    beforeEach(() => {
      proxy.init()
    })

    describe('trace', () => {
      it('should call the underlying DatadogTracer', () => {
        const callback = () => 'test'
        const returnValue = proxy.trace('a', 'b', callback)

        sinon.assert.calledWith(tracer.trace, 'a', 'b', callback)
        assert.strictEqual(returnValue, 'test')
      })

      it('should work without options', () => {
        const callback = () => 'test'
        const returnValue = proxy.trace('a', callback)

        sinon.assert.calledWith(tracer.trace, 'a', {}, callback)
        assert.strictEqual(returnValue, 'test')
      })
    })

    describe('wrap', () => {
      it('should call the underlying DatadogTracer', () => {
        const callback = () => 'test'
        const returnValue = proxy.wrap('a', 'b', callback)

        sinon.assert.calledWith(tracer.wrap, 'a', 'b', callback)
        assert.strictEqual(returnValue, 'fn')
      })

      it('should work without options', () => {
        const callback = () => 'test'
        const returnValue = proxy.wrap('a', callback)

        sinon.assert.calledWith(tracer.wrap, 'a', {}, callback)
        assert.strictEqual(returnValue, 'fn')
      })
    })

    describe('startSpan', () => {
      it('should call the underlying DatadogTracer', () => {
        const returnValue = proxy.startSpan('a', 'b', 'c')

        sinon.assert.calledWith(tracer.startSpan, 'a', 'b', 'c')
        assert.strictEqual(returnValue, 'span')
      })
    })

    describe('inject', () => {
      it('should call the underlying DatadogTracer', () => {
        const returnValue = proxy.inject('a', 'b', 'c')

        sinon.assert.calledWith(tracer.inject, 'a', 'b', 'c')
        assert.strictEqual(returnValue, 'tracer')
      })
    })

    describe('extract', () => {
      it('should call the underlying DatadogTracer', () => {
        const returnValue = proxy.extract('a', 'b', 'c')

        sinon.assert.calledWith(tracer.extract, 'a', 'b', 'c')
        assert.strictEqual(returnValue, 'spanContext')
      })
    })

    describe('setUrl', () => {
      it('should call the underlying DatadogTracer', () => {
        const returnValue = proxy.setUrl('http://example.com')

        sinon.assert.calledWith(tracer.setUrl, 'http://example.com')
        assert.strictEqual(returnValue, proxy)
      })
    })

    describe('appsec', () => {
      describe('trackUserLoginSuccessEvent', () => {
        it('should call the underlying AppsecSdk method', () => {
          const user = { id: 'user_id' }
          const metadata = { metakey1: 'metavalue1' }
          proxy.appsec.trackUserLoginSuccessEvent(user, metadata)
          sinon.assert.calledOnceWithExactly(appsecSdk.trackUserLoginSuccessEvent, user, metadata)
        })
      })

      describe('trackUserLoginFailureEvent', () => {
        it('should call the underlying AppsecSdk method', () => {
          const userId = 'user_id'
          const exists = true
          const metadata = { metakey1: 'metavalue1' }
          proxy.appsec.trackUserLoginFailureEvent(userId, exists, metadata)
          sinon.assert.calledOnceWithExactly(appsecSdk.trackUserLoginFailureEvent, userId, exists, metadata)
        })
      })

      describe('trackCustomEvent', () => {
        it('should call the underlying AppsecSdk method', () => {
          const eventName = 'custom_event'
          const metadata = { metakey1: 'metavalue1' }
          proxy.appsec.trackCustomEvent(eventName, metadata)
          sinon.assert.calledOnceWithExactly(appsecSdk.trackCustomEvent, eventName, metadata)
        })
      })
    })

    describe('aiguard', () => {
      describe('evaluate', () => {
        it('should call the underlying NoopAIGuardSdk method', () => {
          const messages = [{ role: 'user', content: 'What day is today?' }]
          proxy.aiguard.evaluate(messages)
          sinon.assert.calledOnceWithExactly(aiguardSdk.evaluate, messages)
        })
      })
    })
  })
})

// Helper function to create APM_TRACING batch transaction objects
function createApmTracingTransaction (configId, libConfig, action = 'apply') {
  const item = {
    id: configId,
    file: { lib_config: libConfig },
    path: `datadog/1/APM_TRACING/${configId}`
  }

  return {
    toUnapply: action === 'unapply' ? [item] : [],
    toApply: action === 'apply' ? [item] : [],
    toModify: action === 'modify' ? [item] : [],
    ack: sinon.spy(),
    error: sinon.spy()
  }
}
