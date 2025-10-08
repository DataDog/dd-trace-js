'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
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
  let remoteConfig
  let handlers
  let rc
  let dogStatsD
  let noopDogStatsDClient
  let NoopDogStatsDClient
  let OpenFeatureProvider
  let openfeatureProvider

  beforeEach(() => {
    process.env.DD_TRACE_MOCHA_ENABLED = false

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
      configure: sinon.spy(),
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

    remoteConfig = {
      enable: sinon.stub()
    }

    handlers = new Map()
    rc = {
      setProductHandler (product, handler) { handlers.set(product, handler) },
      removeProductHandler (product) { handlers.delete(product) }
    }

    remoteConfig.enable.returns(rc)

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
      './remote_config': remoteConfig,
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
        expect(proxy.init()).to.equal(proxy)
      })

      it('should initialize and configure an instance of DatadogTracer', () => {
        const options = {}

        proxy.init(options)

        expect(Config).to.have.been.calledWith(options)
        expect(DatadogTracer).to.have.been.calledWith(config)
        expect(remoteConfig.enable).to.have.been.calledOnceWith(config)
      })

      it('should not initialize twice', () => {
        proxy.init()
        proxy.init()

        expect(DatadogTracer).to.have.been.calledOnce
        expect(remoteConfig.enable).to.have.been.calledOnce
      })

      it('should not enable remote config when disabled', () => {
        config.remoteConfig.enabled = false

        proxy.init()

        expect(DatadogTracer).to.have.been.calledOnce
        expect(remoteConfig.enable).to.not.have.been.called
      })

      it('should not initialize when disabled', () => {
        config.tracing = false

        proxy.init()

        expect(DatadogTracer).to.not.have.been.called
      })

      it('should not capture runtimeMetrics by default', () => {
        proxy.init()

        expect(runtimeMetrics.start).to.not.have.been.called
      })

      it('should support applying remote config', () => {
        const conf = {}

        proxy.init()

        handlers.get('APM_TRACING')('apply', { lib_config: conf })

        expect(config.configure).to.have.been.calledWith(conf)
        expect(tracer.configure).to.have.been.calledWith(config)
        expect(pluginManager.configure).to.have.been.calledWith(config)
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

        expect(flare.enable).to.have.been.calledWith(config)
        expect(flare.prepare).to.have.been.calledWith(logLevel)
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

        expect(flare.enable).to.have.been.calledWith(config)
        expect(flare.send).to.have.been.calledWith(task)
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

        expect(flare.disable).to.have.been.called
      })

      it('should setup FFE_FLAGS product handler when openfeature provider is enabled', () => {
        config.experimental.flaggingProvider.enabled = true

        proxy.init()
        proxy.openfeature // Trigger lazy loading

        const flagConfig = { flags: { 'test-flag': {} } }
        handlers.get('FFE_FLAGS')('apply', { flag_configuration: flagConfig })

        expect(openfeatureProvider._setConfiguration).to.have.been.calledWith(flagConfig)
      })

      it('should handle FFE_FLAGS modify action', () => {
        config.experimental.flaggingProvider.enabled = true

        proxy.init()
        proxy.openfeature // Trigger lazy loading

        const flagConfig = { flags: { 'modified-flag': {} } }
        handlers.get('FFE_FLAGS')('modify', { flag_configuration: flagConfig })

        expect(openfeatureProvider._setConfiguration).to.have.been.calledWith(flagConfig)
      })

      it('should support applying remote config', () => {
        const RemoteConfigProxy = proxyquire('../src/proxy', {
          './tracer': DatadogTracer,
          './appsec': appsec,
          './appsec/iast': iast,
          './remote_config': remoteConfig,
          './appsec/sdk': AppsecSdk
        })

        const remoteConfigProxy = new RemoteConfigProxy()
        remoteConfigProxy.init()
        remoteConfigProxy.appsec // Eagerly trigger lazy loading.
        expect(DatadogTracer).to.have.been.calledOnce
        expect(AppsecSdk).to.have.been.calledOnce
        expect(appsec.enable).to.not.have.been.called
        expect(iast.enable).to.not.have.been.called

        let conf = { tracing_enabled: false }
        handlers.get('APM_TRACING')('apply', { lib_config: conf })
        expect(appsec.disable).to.not.have.been.called
        expect(iast.disable).to.not.have.been.called

        conf = { tracing_enabled: true }
        handlers.get('APM_TRACING')('apply', { lib_config: conf })
        expect(DatadogTracer).to.have.been.calledOnce
        expect(AppsecSdk).to.have.been.calledOnce
        expect(appsec.enable).to.not.have.been.called
        expect(iast.enable).to.not.have.been.called
      })

      it('should support applying remote config (only call disable if enabled before)', () => {
        const RemoteConfigProxy = proxyquire('../src/proxy', {
          './tracer': DatadogTracer,
          './config': Config,
          './appsec': appsec,
          './appsec/iast': iast,
          './remote_config': remoteConfig,
          './appsec/sdk': AppsecSdk
        })

        config.telemetry = {}
        config.appsec.enabled = true
        config.iast.enabled = true
        config.configure = conf => {
          config.tracing = conf.tracing_enabled
        }

        const remoteConfigProxy = new RemoteConfigProxy()
        remoteConfigProxy.init()

        expect(appsec.enable).to.have.been.calledOnceWithExactly(config)
        expect(iast.enable).to.have.been.calledOnceWithExactly(config, tracer)

        let conf = { tracing_enabled: false }
        handlers.get('APM_TRACING')('apply', { lib_config: conf })
        expect(appsec.disable).to.have.been.called
        expect(iast.disable).to.have.been.called

        conf = { tracing_enabled: true }
        handlers.get('APM_TRACING')('apply', { lib_config: conf })
        expect(appsec.enable).to.have.been.calledTwice
        expect(appsec.enable.secondCall).to.have.been.calledWithExactly(config)
        expect(iast.enable).to.have.been.calledTwice
        expect(iast.enable.secondCall).to.have.been.calledWithExactly(config, tracer)
      })

      it('should start capturing runtimeMetrics when configured', () => {
        config.runtimeMetrics.enabled = true

        proxy.init()

        expect(runtimeMetrics.start).to.have.been.called
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

        expect(dogStatsD._config().dogstatsd.hostname).to.equal('localhost')
        expect(incs.length).to.equal(1)
        expect(incs[0][0]).to.equal('foo')
        expect(incs[0][1]).to.equal(10)
        expect(incs[0][2]).to.deep.equal({ alpha: 'bravo' })
      })

      it('should enable appsec when explicitly configured to true', () => {
        config.appsec = { enabled: true }

        proxy.init()

        expect(appsec.enable).to.have.been.called
      })

      it('should not enable appsec when explicitly configured to false', () => {
        config.appsec = { enabled: false }

        proxy.init()

        expect(appsec.enable).to.not.have.been.called
      })

      it('should enable iast when configured', () => {
        config.iast = { enabled: true }

        proxy.init()

        expect(iast.enable).to.have.been.calledOnce
      })

      it('should not enable iast when it is not configured', () => {
        config.iast = {}

        proxy.init()

        expect(iast.enable).not.to.have.been.called
      })

      it('should not load the profiler when not configured', () => {
        config.profiling = { enabled: false }

        proxy.init()

        expect(profiler.start).to.not.have.been.called
      })

      it('should not load the profiler when profiling config does not exist', () => {
        config.pro_fil_ing = 'invalidConfig'

        proxy.init()

        expect(profiler.start).to.not.have.been.called
      })

      it('should load profiler when configured', () => {
        config.profiling = { enabled: 'true' }

        proxy.init()

        expect(profiler.start).to.have.been.called
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
          './remote_config': remoteConfig
        })

        const profilerImportFailureProxy = new ProfilerImportFailureProxy()
        profilerImportFailureProxy.init()

        sinon.assert.calledOnce(log.error)
        const expectedErr = sinon.match.instanceOf(Error).and(sinon.match.has('code', 'MODULE_NOT_FOUND'))
        sinon.assert.match(log.error.firstCall.lastArg, sinon.match(expectedErr))
      })

      it('should start telemetry', () => {
        proxy.init()

        expect(telemetry.start).to.have.been.called
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
          './remote_config': remoteConfig,
          './appsec/sdk': AppsecSdk,
          './standalone': standalone,
          './telemetry': telemetry
        })

        const proxy = new DatadogProxy()
        proxy.init(options)
        proxy.appsec // Eagerly trigger lazy loading.

        const config = AppsecSdk.firstCall.args[1]
        expect(standalone.configure).to.have.been.calledOnceWithExactly(config)
      })
    })

    describe('trace', () => {
      it('should call the underlying NoopTracer', () => {
        const callback = () => 'test'
        const returnValue = proxy.trace('a', 'b', callback)

        expect(noop.trace).to.have.been.calledWith('a', 'b', callback)
        expect(returnValue).to.equal('test')
      })

      it('should work without options', () => {
        const callback = () => 'test'
        const returnValue = proxy.trace('a', callback)

        expect(noop.trace).to.have.been.calledWith('a', {}, callback)
        expect(returnValue).to.equal('test')
      })

      it('should ignore calls without an invalid callback', () => {
        proxy.wrap('a', 'b')

        expect(noop.trace).to.not.have.been.called
      })
    })

    describe('wrap', () => {
      it('should call the underlying NoopTracer', () => {
        const callback = () => 'test'
        const returnValue = proxy.wrap('a', 'b', callback)

        expect(noop.wrap).to.have.been.calledWith('a', 'b', callback)
        expect(returnValue).to.equal('fn')
      })

      it('should work without options', () => {
        const callback = () => 'test'
        const returnValue = proxy.wrap('a', callback)

        expect(noop.wrap).to.have.been.calledWith('a', {}, callback)
        expect(returnValue).to.equal('fn')
      })

      it('should ignore calls without an invalid callback', () => {
        const returnValue = proxy.wrap('a', 'b')

        expect(noop.wrap).to.not.have.been.called
        expect(returnValue).to.equal('b')
      })
    })

    describe('startSpan', () => {
      it('should call the underlying NoopTracer', () => {
        const returnValue = proxy.startSpan('a', 'b', 'c')

        expect(noop.startSpan).to.have.been.calledWith('a', 'b', 'c')
        expect(returnValue).to.equal('span')
      })
    })

    describe('inject', () => {
      it('should call the underlying NoopTracer', () => {
        const returnValue = proxy.inject('a', 'b', 'c')

        expect(noop.inject).to.have.been.calledWith('a', 'b', 'c')
        expect(returnValue).to.equal('noop')
      })
    })

    describe('extract', () => {
      it('should call the underlying NoopTracer', () => {
        const returnValue = proxy.extract('a', 'b', 'c')

        expect(noop.extract).to.have.been.calledWith('a', 'b', 'c')
        expect(returnValue).to.equal('spanContext')
      })
    })

    describe('setUrl', () => {
      it('should call the underlying DatadogTracer', () => {
        const returnValue = proxy.setUrl('http://example.com')

        expect(noop.setUrl).to.have.been.calledWith('http://example.com')
        expect(returnValue).to.equal(proxy)
      })
    })

    describe('baggage', () => {
      afterEach(() => {
        proxy.removeAllBaggageItems()
      })

      describe('setBaggageItem', () => {
        it('should set a baggage item', () => {
          const baggage = proxy.setBaggageItem('key', 'value')
          expect(baggage).to.deep.equal({ key: 'value' })
        })

        it('should merge with existing baggage items', () => {
          proxy.setBaggageItem('key1', 'value1')
          const baggage = proxy.setBaggageItem('key2', 'value2')
          expect(baggage).to.deep.equal({ key1: 'value1', key2: 'value2' })
        })
      })

      describe('getBaggageItem', () => {
        it('should get a baggage item', () => {
          proxy.setBaggageItem('key', 'value')
          expect(proxy.getBaggageItem('key')).to.equal('value')
        })

        it('should return undefined for non-existent items', () => {
          expect(proxy.getBaggageItem('missing')).to.be.undefined
        })
      })

      describe('getAllBaggageItems', () => {
        it('should get all baggage items', () => {
          proxy.setBaggageItem('key1', 'value1')
          proxy.setBaggageItem('key2', 'value2')
          expect(proxy.getAllBaggageItems()).to.deep.equal({ key1: 'value1', key2: 'value2' })
        })

        it('should return empty object when no items exist', () => {
          expect(proxy.getAllBaggageItems()).to.deep.equal({})
        })
      })

      describe('removeBaggageItem', () => {
        it('should remove a specific baggage item', () => {
          proxy.setBaggageItem('key1', 'value1')
          proxy.setBaggageItem('key2', 'value2')
          const baggage = proxy.removeBaggageItem('key1')
          expect(baggage).to.deep.equal({ key2: 'value2' })
        })

        it('should handle removing non-existent items', () => {
          proxy.setBaggageItem('key', 'value')
          const baggage = proxy.removeBaggageItem('missing')
          expect(baggage).to.deep.equal({ key: 'value' })
        })
      })

      describe('removeAllBaggageItems', () => {
        it('should remove all baggage items', () => {
          proxy.setBaggageItem('key1', 'value1')
          proxy.setBaggageItem('key2', 'value2')
          const baggage = proxy.removeAllBaggageItems()
          expect(baggage).to.be.undefined
        })
      })
    })

    describe('appsec', () => {
      describe('trackUserLoginSuccessEvent', () => {
        it('should call the underlying NoopAppsecSdk method', () => {
          const user = { id: 'user_id' }
          const metadata = { metakey1: 'metavalue1' }
          proxy.appsec.trackUserLoginSuccessEvent(user, metadata)
          expect(noopAppsecSdk.trackUserLoginSuccessEvent).to.have.been.calledOnceWithExactly(user, metadata)
        })
      })

      describe('trackUserLoginFailureEvent', () => {
        it('should call the underlying NoopAppsecSdk method', () => {
          const userId = 'user_id'
          const exists = true
          const metadata = { metakey1: 'metavalue1' }
          proxy.appsec.trackUserLoginFailureEvent(userId, exists, metadata)
          expect(noopAppsecSdk.trackUserLoginFailureEvent).to.have.been.calledOnceWithExactly(userId, exists, metadata)
        })
      })

      describe('trackCustomEvent', () => {
        it('should call the underlying NoopAppsecSdk method', () => {
          const eventName = 'custom_event'
          const metadata = { metakey1: 'metavalue1' }
          proxy.appsec.trackCustomEvent(eventName, metadata)
          expect(noopAppsecSdk.trackCustomEvent).to.have.been.calledOnceWithExactly(eventName, metadata)
        })
      })
    })

    describe('dogstatsd', () => {
      it('should not throw when calling noop methods', () => {
        proxy.dogstatsd.increment('inc')
        expect(noopDogStatsDClient.increment).to.have.been.calledWith('inc')
        proxy.dogstatsd.decrement('dec')
        expect(noopDogStatsDClient.decrement).to.have.been.calledWith('dec')
        proxy.dogstatsd.distribution('dist')
        expect(noopDogStatsDClient.distribution).to.have.been.calledWith('dist')
        proxy.dogstatsd.histogram('hist')
        expect(noopDogStatsDClient.histogram).to.have.been.calledWith('hist')
        proxy.dogstatsd.flush()
        expect(noopDogStatsDClient.flush).to.have.been.called
      })
    })
  })

  describe('aiguard', () => {
    describe('evaluate', () => {
      it('should call the underlying NoopAIGuardSdk method', () => {
        const messages = [{ role: 'user', content: 'What day is today?' }]
        proxy.aiguard.evaluate(messages)
        expect(noopAiguardSdk.evaluate).to.have.been.calledOnceWithExactly(messages)
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

        expect(tracer.trace).to.have.been.calledWith('a', 'b', callback)
        expect(returnValue).to.equal('test')
      })

      it('should work without options', () => {
        const callback = () => 'test'
        const returnValue = proxy.trace('a', callback)

        expect(tracer.trace).to.have.been.calledWith('a', {}, callback)
        expect(returnValue).to.equal('test')
      })
    })

    describe('wrap', () => {
      it('should call the underlying DatadogTracer', () => {
        const callback = () => 'test'
        const returnValue = proxy.wrap('a', 'b', callback)

        expect(tracer.wrap).to.have.been.calledWith('a', 'b', callback)
        expect(returnValue).to.equal('fn')
      })

      it('should work without options', () => {
        const callback = () => 'test'
        const returnValue = proxy.wrap('a', callback)

        expect(tracer.wrap).to.have.been.calledWith('a', {}, callback)
        expect(returnValue).to.equal('fn')
      })
    })

    describe('startSpan', () => {
      it('should call the underlying DatadogTracer', () => {
        const returnValue = proxy.startSpan('a', 'b', 'c')

        expect(tracer.startSpan).to.have.been.calledWith('a', 'b', 'c')
        expect(returnValue).to.equal('span')
      })
    })

    describe('inject', () => {
      it('should call the underlying DatadogTracer', () => {
        const returnValue = proxy.inject('a', 'b', 'c')

        expect(tracer.inject).to.have.been.calledWith('a', 'b', 'c')
        expect(returnValue).to.equal('tracer')
      })
    })

    describe('extract', () => {
      it('should call the underlying DatadogTracer', () => {
        const returnValue = proxy.extract('a', 'b', 'c')

        expect(tracer.extract).to.have.been.calledWith('a', 'b', 'c')
        expect(returnValue).to.equal('spanContext')
      })
    })

    describe('setUrl', () => {
      it('should call the underlying DatadogTracer', () => {
        const returnValue = proxy.setUrl('http://example.com')

        expect(tracer.setUrl).to.have.been.calledWith('http://example.com')
        expect(returnValue).to.equal(proxy)
      })
    })

    describe('appsec', () => {
      describe('trackUserLoginSuccessEvent', () => {
        it('should call the underlying AppsecSdk method', () => {
          const user = { id: 'user_id' }
          const metadata = { metakey1: 'metavalue1' }
          proxy.appsec.trackUserLoginSuccessEvent(user, metadata)
          expect(appsecSdk.trackUserLoginSuccessEvent).to.have.been.calledOnceWithExactly(user, metadata)
        })
      })

      describe('trackUserLoginFailureEvent', () => {
        it('should call the underlying AppsecSdk method', () => {
          const userId = 'user_id'
          const exists = true
          const metadata = { metakey1: 'metavalue1' }
          proxy.appsec.trackUserLoginFailureEvent(userId, exists, metadata)
          expect(appsecSdk.trackUserLoginFailureEvent).to.have.been.calledOnceWithExactly(userId, exists, metadata)
        })
      })

      describe('trackCustomEvent', () => {
        it('should call the underlying AppsecSdk method', () => {
          const eventName = 'custom_event'
          const metadata = { metakey1: 'metavalue1' }
          proxy.appsec.trackCustomEvent(eventName, metadata)
          expect(appsecSdk.trackCustomEvent).to.have.been.calledOnceWithExactly(eventName, metadata)
        })
      })
    })

    describe('aiguard', () => {
      describe('evaluate', () => {
        it('should call the underlying NoopAIGuardSdk method', () => {
          const messages = [{ role: 'user', content: 'What day is today?' }]
          proxy.aiguard.evaluate(messages)
          expect(aiguardSdk.evaluate).to.have.been.calledOnceWithExactly(messages)
        })
      })
    })
  })
})
