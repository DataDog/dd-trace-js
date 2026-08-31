'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { once } = require('node:events')
const http = require('node:http')
const path = require('node:path')
const { inspect } = require('node:util')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const { storage } = require('../../datadog-core')
const RemoteConfigCapabilities = require('../src/remote_config/capabilities')

require('./setup/core')

const legacyStorage = storage('legacy')

describe('TracerProxy', () => {
  let ProxyClass
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
  let dynamicInstrumentation
  let log
  let profiler
  let appsec
  let aiguard
  let telemetry
  let iast
  let rewriter
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
  let registerTelemetryFlusher
  let initializeServerlessTelemetry
  let supportsServerlessTelemetryRetention
  let flushServerlessTelemetry

  beforeEach(() => {
    process.env.DD_TRACE_MOCHA_ENABLED = 'false'

    aiguardSdk = {
      evaluate: sinon.stub(),
    }

    appsecSdk = {
      trackUserLoginSuccessEvent: sinon.stub(),
      trackUserLoginFailureEvent: sinon.stub(),
      trackCustomEvent: sinon.stub(),
    }

    pluginManager = {
      configure: sinon.spy(),
    }

    tracer = {
      use: sinon.stub().returns('tracer'),
      trace: sinon.stub().returns('test'),
      wrap: sinon.stub().returns('fn'),
      startSpan: sinon.stub().returns('span'),
      inject: sinon.stub().returns('tracer'),
      extract: sinon.stub().returns('spanContext'),
      setUrl: sinon.stub(),
      configure: sinon.spy(),
    }

    noop = {
      use: sinon.stub().returns('tracer'),
      trace: sinon.stub().returns('test'),
      wrap: sinon.stub().returns('fn'),
      startSpan: sinon.stub().returns('span'),
      inject: sinon.stub().returns('noop'),
      extract: sinon.stub().returns('spanContext'),
      setUrl: sinon.stub(),
      configure: sinon.spy(),
    }

    noopAiguardSdk = {
      evaluate: sinon.stub(),
    }

    noopAppsecSdk = {
      trackUserLoginSuccessEvent: sinon.stub(),
      trackUserLoginFailureEvent: sinon.stub(),
      trackCustomEvent: sinon.stub(),
    }

    noopDogStatsDClient = {
      increment: sinon.spy(),
      decrement: sinon.spy(),
      gauge: sinon.spy(),
      distribution: sinon.spy(),
      histogram: sinon.spy(),
      flush: sinon.spy(),
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
        _flushes: () => dogstatsdFlushes,
      }
    }

    log = {
      error: sinon.spy(),
      warn: sinon.spy(),
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
      DD_TRACE_ENABLED: true,
      testOptimization: {},
      featureFlags: {
        DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'agentless',
        DD_FEATURE_FLAGS_ENABLED: false,
      },
      experimental: {
        flaggingProvider: {},
        aiguard: {
          enabled: true,
        },
      },
      DD_INJECTION_ENABLED: undefined,
      logger: 'logger',
      profiling: {},
      apmTracingEnabled: false,
      appsec: {},
      iast: {},
      DD_CRASHTRACKING_ENABLED: false,
      dynamicInstrumentation: {},
      remoteConfig: {
        DD_REMOTE_CONFIGURATION_ENABLED: true,
      },
      runtimeMetrics: {
        enabled: false,
      },
      setRemoteConfig: sinon.stub(),
      llmobs: {},
    }
    Config = sinon.stub().returns(config)

    runtimeMetrics = {
      start: sinon.spy(),
      flush: sinon.spy(),
    }

    dynamicInstrumentation = {
      configure: sinon.spy(),
      isStarted: sinon.stub().returns(false),
      start: sinon.spy(),
      stop: sinon.spy(),
    }

    registerTelemetryFlusher = sinon.stub().returns(() => {})
    initializeServerlessTelemetry = sinon.spy()
    supportsServerlessTelemetryRetention = sinon.stub().returns(true)
    flushServerlessTelemetry = sinon.spy()

    profiler = {
      start: sinon.spy(),
    }

    appsec = {
      enable: sinon.spy(),
      disable: sinon.spy(),
    }

    aiguard = {
      enable: sinon.spy(),
      disable: sinon.spy(),
    }

    telemetry = {
      start: sinon.spy(),
    }

    iast = {
      enable: sinon.spy(),
      disable: sinon.spy(),
    }

    rewriter = {
      enable: sinon.spy(),
      disable: sinon.spy(),
    }

    openfeature = {
      enable: sinon.spy(),
      disable: sinon.spy(),
    }

    OpenFeatureProvider = sinon.stub().callsFake(function () {
      openfeatureProvider = {
        setConfiguration: sinon.spy(),
      }
      return openfeatureProvider
    })

    flare = {
      enable: sinon.spy(),
      disable: sinon.spy(),
      prepare: sinon.spy(),
      send: sinon.spy(),
      cleanup: sinon.spy(),
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
      unsubscribeProducts: sinon.spy(),
    }

    RemoteConfig = sinon.stub().returns(rc)

    NoopProxy = proxyquire('../src/noop/proxy', {
      './tracer': NoopTracer,
      '../aiguard/noop': NoopAIGuardSdk,
      '../appsec/sdk/noop': NoopAppsecSdk,
      './dogstatsd': NoopDogStatsDClient,
    })

    ProxyClass = proxyquire('../src/proxy', {
      './tracer': DatadogTracer,
      './noop/proxy': NoopProxy,
      './config': Config,
      './plugin_manager': PluginManager,
      './runtime_metrics': runtimeMetrics,
      './debugger': dynamicInstrumentation,
      './log': log,
      './profiler': profiler,
      './appsec': appsec,
      './appsec/iast': iast,
      './appsec/iast/taint-tracking/rewriter': rewriter,
      './aiguard': aiguard,
      './telemetry': telemetry,
      './remote_config': RemoteConfig,
      './aiguard/sdk': AIGuardSdk,
      './appsec/sdk': AppsecSdk,
      './dogstatsd': dogStatsD,
      './noop/dogstatsd': NoopDogStatsDClient,
      './flare': flare,
      './openfeature': openfeature,
      './openfeature/flagging_provider': OpenFeatureProvider,
      './serverless': {
        IS_SERVERLESS: false,
        initializeServerlessTelemetry,
        supportsServerlessTelemetryRetention,
      },
      './flush': { flushServerlessTelemetry, registerTelemetryFlusher },
    })

    proxy = new ProxyClass()
  })

  describe('uninitialized', () => {
    it('does not load inactive feature modules when required', () => {
      const entry = require.resolve('..')
      const optionalModules = [
        require.resolve('../src/debugger'),
        require.resolve('../src/llmobs/experiments/noop'),
      ]
      const script = `
        const optionalModules = ${JSON.stringify(optionalModules)}
        require(${JSON.stringify(entry)})
        process.stdout.write(JSON.stringify(optionalModules.map(path => require.cache[path] !== undefined)))
      `
      const result = spawnSync(process.execPath, ['--eval', script], { encoding: 'utf8', timeout: 5_000 })

      assert.strictEqual(result.status, 0, result.stderr)
      assert.deepStrictEqual(JSON.parse(result.stdout), [false, false])
    })

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
        sinon.assert.notCalled(rewriter.enable)
      })

      it('only loads Test Optimization startup modules through ci/init', () => {
        const repoRoot = path.resolve(__dirname, '../../..')
        const testOptimizationRoot = path.join(repoRoot, 'packages/dd-trace/src/ci-visibility') + path.sep
        const modules = [
          require.resolve('../src/ci-visibility/test-api-manual/test-api-manual-plugin'),
          require.resolve('../src/ci-visibility/log-submission/log-submission-plugin'),
          require.resolve('../src/ci-visibility/dynamic-instrumentation'),
        ]
        const script = `
          const tracer = require(process.env.DD_TRACE_TEST_ENTRYPOINT)
          if (process.env.DD_TRACE_TEST_CALL_INIT === 'true') {
            tracer.init()
          }
          const modules = ${JSON.stringify(modules)}
          const loaded = modules.map(module => require.cache[module] !== undefined)
          const testOptimizationModuleCount = Object.keys(require.cache)
            .filter(module => module.startsWith(${JSON.stringify(testOptimizationRoot)}))
            .length
          process.stdout.write(JSON.stringify({ loaded, testOptimizationModuleCount }), () => process.exit())
        `
        const cases = [
          {
            entrypoint: repoRoot,
            callInit: 'true',
            environment: { DD_AGENTLESS_LOG_SUBMISSION_ENABLED: 'true' },
            expected: [false, false, false],
            expectedTestOptimizationModuleCount: 0,
          },
          { entrypoint: path.join(repoRoot, 'ci/init'), callInit: 'false', expected: [true, false, true] },
          {
            entrypoint: path.join(repoRoot, 'ci/init'),
            callInit: 'false',
            environment: { DD_AGENTLESS_LOG_SUBMISSION_ENABLED: 'true' },
            expected: [true, true, true],
          },
          {
            entrypoint: path.join(repoRoot, 'ci/init'),
            callInit: 'false',
            environment: {
              DD_CIVISIBILITY_MANUAL_API_ENABLED: 'false',
              DD_TEST_FAILED_TEST_REPLAY_ENABLED: 'false',
            },
            expected: [false, false, false],
          },
        ]

        for (const testCase of cases) {
          const result = spawnSync(process.execPath, ['--eval', script], {
            encoding: 'utf8',
            env: {
              ...process.env,
              DD_AGENTLESS_LOG_SUBMISSION_ENABLED: 'false',
              DD_API_KEY: 'test-api-key',
              DD_CIVISIBILITY_AGENTLESS_ENABLED: 'false',
              DD_CIVISIBILITY_ENABLED: 'true',
              DD_CIVISIBILITY_MANUAL_API_ENABLED: 'true',
              DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
              DD_REMOTE_CONFIGURATION_ENABLED: 'false',
              DD_TEST_FAILED_TEST_REPLAY_ENABLED: 'true',
              DD_TRACE_ENABLED: 'true',
              DD_TRACE_STARTUP_LOGS: 'false',
              DD_TRACE_TEST_CALL_INIT: testCase.callInit,
              DD_TRACE_TEST_ENTRYPOINT: testCase.entrypoint,
              ...testCase.environment,
            },
          })

          assert.strictEqual(result.status, 0, result.stderr)
          const { loaded, testOptimizationModuleCount } = JSON.parse(result.stdout)
          assert.deepStrictEqual(loaded, testCase.expected)
          if (testCase.expectedTestOptimizationModuleCount !== undefined) {
            assert.strictEqual(testOptimizationModuleCount, testCase.expectedTestOptimizationModuleCount)
          }
        }
      })

      it('does not load Dynamic Instrumentation while disabled', () => {
        proxy.init()

        sinon.assert.notCalled(dynamicInstrumentation.configure)
        sinon.assert.notCalled(dynamicInstrumentation.isStarted)
        sinon.assert.notCalled(dynamicInstrumentation.start)
        sinon.assert.notCalled(dynamicInstrumentation.stop)
      })

      it('starts and configures Dynamic Instrumentation when enabled', () => {
        config.dynamicInstrumentation.enabled = true

        proxy.init()

        sinon.assert.calledOnceWithExactly(dynamicInstrumentation.start, config, rc)
        sinon.assert.calledOnceWithExactly(dynamicInstrumentation.configure, config)
      })

      it('should enable the IAST rewriter when IAST is enabled', () => {
        config.iast.enabled = true

        proxy.init()

        sinon.assert.calledOnceWithExactly(rewriter.enable, config)
      })

      it('should not initialize twice', () => {
        proxy.init()
        proxy.init()

        sinon.assert.calledOnce(DatadogTracer)
        sinon.assert.calledOnce(RemoteConfig)
      })

      it('should not enable remote config when disabled', () => {
        config.remoteConfig.DD_REMOTE_CONFIGURATION_ENABLED = false

        proxy.init()

        sinon.assert.calledOnce(DatadogTracer)
        sinon.assert.notCalled(RemoteConfig)
      })

      it('should not initialize when disabled', () => {
        config.DD_TRACE_ENABLED = false

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

      it('does not load Dynamic Instrumentation for a disabled remote config update', () => {
        config.setRemoteConfig.callsFake(conf => {
          config.dynamicInstrumentation.enabled = conf['dynamicInstrumentation.enabled']
        })
        proxy.init()

        handlers.get('APM_TRACING')(createApmTracingTransaction('debugger-disabled', {
          dynamic_instrumentation_enabled: false,
        }))

        sinon.assert.notCalled(dynamicInstrumentation.configure)
        sinon.assert.notCalled(dynamicInstrumentation.isStarted)
        sinon.assert.notCalled(dynamicInstrumentation.start)
        sinon.assert.notCalled(dynamicInstrumentation.stop)
      })

      it('loads Dynamic Instrumentation when remote config enables it', () => {
        config.setRemoteConfig.callsFake(conf => {
          config.dynamicInstrumentation.enabled = conf['dynamicInstrumentation.enabled']
        })
        proxy.init()

        handlers.get('APM_TRACING')(createApmTracingTransaction('debugger-enabled', {
          dynamic_instrumentation_enabled: true,
        }))

        sinon.assert.calledOnce(dynamicInstrumentation.isStarted)
        sinon.assert.calledOnceWithExactly(dynamicInstrumentation.start, config, rc)
        sinon.assert.notCalled(dynamicInstrumentation.configure)
        sinon.assert.notCalled(dynamicInstrumentation.stop)
      })

      it('should support enabling debug logs for tracer flares', () => {
        const logLevel = 'debug'

        proxy.init()

        handlers.get('AGENT_CONFIG')('apply', {
          config: {
            log_level: logLevel,
          },
          name: 'flare-log-level.debug',
        })

        sinon.assert.calledWith(flare.enable, config)
        sinon.assert.calledWith(flare.prepare, logLevel)
      })

      it('should support sending tracer flares', () => {
        const task = {
          case_id: '111',
          hostname: 'myhostname',
          user_handle: 'user.name@datadoghq.com',
        }

        proxy.init()

        handlers.get('AGENT_TASK')('apply', {
          args: task,
          task_type: 'tracer_flare',
          uuid: 'd53fc8a4-8820-47a2-aa7d-d565582feb81',
        })

        sinon.assert.calledWith(flare.enable, config)
        sinon.assert.calledWith(flare.send, task)
      })

      it('should cleanup flares when the config is removed', () => {
        const conf = {
          config: {
            log_level: 'debug',
          },
          name: 'flare-log-level.debug',
        }

        proxy.init()

        handlers.get('AGENT_CONFIG')('apply', conf)
        handlers.get('AGENT_CONFIG')('unapply', conf)

        sinon.assert.called(flare.disable)
      })

      it('does not load OpenFeature before application access', () => {
        config.featureFlags.DD_FEATURE_FLAGS_ENABLED = true

        proxy.init()

        const descriptor = Reflect.getOwnPropertyDescriptor(proxy, 'openfeature')
        assert.strictEqual(typeof descriptor.get, 'function')
        sinon.assert.notCalled(OpenFeatureProvider)
        sinon.assert.notCalled(openfeature.enable)
      })

      it('does not enable OpenFeature when provider construction fails', () => {
        config.featureFlags.DD_FEATURE_FLAGS_ENABLED = true
        OpenFeatureProvider.throws(new Error('provider unavailable'))

        proxy.init()

        assert.throws(() => proxy.openfeature, /provider unavailable/)
        sinon.assert.notCalled(openfeature.enable)
      })

      it('should setup FFE_FLAGS product handler when openfeature provider is enabled', () => {
        config.featureFlags.DD_FEATURE_FLAGS_ENABLED = true
        config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE = 'remote_config'

        proxy.init()
        proxy.openfeature // Trigger lazy loading

        const flagConfig = { flags: { 'test-flag': {} } }
        handlers.get('FFE_FLAGS')('apply', flagConfig)

        sinon.assert.calledWith(openfeatureProvider.setConfiguration, flagConfig)
      })

      it('applies FFE_FLAGS while tracing is disabled', () => {
        config.DD_TRACE_ENABLED = false
        config.featureFlags.DD_FEATURE_FLAGS_ENABLED = true
        config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE = 'remote_config'

        proxy.init()

        const flagConfig = { flags: { 'test-flag': {} } }
        handlers.get('FFE_FLAGS')('apply', flagConfig)

        sinon.assert.notCalled(DatadogTracer)
        sinon.assert.calledOnce(OpenFeatureProvider)
        sinon.assert.calledOnceWithExactly(openfeatureProvider.setConfiguration, flagConfig)
      })

      it('should not setup FFE_FLAGS Remote Config when Feature Flags are disabled', () => {
        proxy.init()

        assert.strictEqual(handlers.has('FFE_FLAGS'), false)
        sinon.assert.neverCalledWith(
          rc.updateCapabilities,
          RemoteConfigCapabilities.FFE_FLAG_CONFIGURATION_RULES,
          true
        )
      })

      it('should handle FFE_FLAGS modify action', () => {
        config.featureFlags.DD_FEATURE_FLAGS_ENABLED = true
        config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE = 'remote_config'

        proxy.init()
        proxy.openfeature // Trigger lazy loading

        const flagConfig = { flags: { 'modified-flag': {} } }
        handlers.get('FFE_FLAGS')('modify', flagConfig)

        sinon.assert.calledWith(openfeatureProvider.setConfiguration, flagConfig)
      })

      it('keeps OpenFeature bound to the provider receiving FFE_FLAGS after tracing reconfigures', () => {
        config.featureFlags.DD_FEATURE_FLAGS_ENABLED = true
        config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE = 'remote_config'

        proxy.init()
        const boundProvider = proxy.openfeature

        handlers.get('APM_TRACING')(createApmTracingTransaction('ffe-reconfig', { DD_TRACE_ENABLED: true }, 'modify'))

        const flagConfig = { flags: { 'test-flag': {} } }
        handlers.get('FFE_FLAGS')('apply', flagConfig)

        sinon.assert.calledOnce(OpenFeatureProvider)
        assert.strictEqual(proxy.openfeature, boundProvider)
        sinon.assert.calledOnceWithExactly(boundProvider.setConfiguration, flagConfig)
      })

      it('keeps OpenFeature active while tracing is disabled and re-enabled', () => {
        config.featureFlags.DD_FEATURE_FLAGS_ENABLED = true
        config.featureFlags.DD_FEATURE_FLAGS_CONFIGURATION_SOURCE = 'remote_config'
        /** @param {{ DD_TRACE_ENABLED: boolean }} remoteConfig */
        config.setRemoteConfig = remoteConfig => {
          config.DD_TRACE_ENABLED = remoteConfig.DD_TRACE_ENABLED
        }

        proxy.init()

        const provider = proxy.openfeature
        handlers.get('APM_TRACING')(createApmTracingTransaction('ffe-disable', { DD_TRACE_ENABLED: false }))
        handlers.get('APM_TRACING')(createApmTracingTransaction('ffe-enable', { DD_TRACE_ENABLED: true }, 'modify'))

        assert.strictEqual(proxy.openfeature, provider)
        sinon.assert.calledOnce(OpenFeatureProvider)
        sinon.assert.calledOnce(openfeature.enable)
        sinon.assert.notCalled(openfeature.disable)
      })

      it('should re-enable AI Guard when remote config re-enables tracing', () => {
        /** @param {{ DD_TRACE_ENABLED: boolean }} remoteConfig */
        config.setRemoteConfig = remoteConfig => {
          config.DD_TRACE_ENABLED = remoteConfig.DD_TRACE_ENABLED
        }

        proxy.init()
        const sdk = proxy.aiguard

        handlers.get('APM_TRACING')(createApmTracingTransaction('aiguard-disable', { DD_TRACE_ENABLED: false }))
        handlers.get('APM_TRACING')(createApmTracingTransaction('aiguard-enable', { DD_TRACE_ENABLED: true }, 'modify'))

        assert.strictEqual(proxy.aiguard, sdk)
        sinon.assert.calledOnce(AIGuardSdk)
        sinon.assert.calledTwice(aiguard.enable)
        sinon.assert.calledOnce(aiguard.disable)
      })

      it('should support applying remote config', () => {
        const RemoteConfigProxy = proxyquire('../src/proxy', {
          './tracer': DatadogTracer,
          './appsec': appsec,
          './appsec/iast': iast,
          './remote_config': RemoteConfig,
          './appsec/sdk': AppsecSdk,
        })

        const remoteConfigProxy = new RemoteConfigProxy()
        remoteConfigProxy.init()
        remoteConfigProxy.appsec // Eagerly trigger lazy loading.
        sinon.assert.calledOnce(DatadogTracer)
        sinon.assert.calledOnce(AppsecSdk)
        sinon.assert.notCalled(appsec.enable)
        sinon.assert.notCalled(iast.enable)

        let conf = { DD_TRACE_ENABLED: false }
        handlers.get('APM_TRACING')(createApmTracingTransaction('test-config-1', conf))
        sinon.assert.notCalled(appsec.disable)
        sinon.assert.notCalled(iast.disable)

        conf = { DD_TRACE_ENABLED: true }
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
          './appsec/sdk': AppsecSdk,
        })

        config.telemetry = {}
        config.appsec.enabled = true
        config.iast.enabled = true
        config.setRemoteConfig = conf => {
          config.DD_TRACE_ENABLED = conf.DD_TRACE_ENABLED
        }

        const remoteConfigProxy = new RemoteConfigProxy()
        remoteConfigProxy.init()

        sinon.assert.calledOnceWithExactly(appsec.enable, config)
        sinon.assert.calledOnceWithExactly(iast.enable, config, tracer)

        let conf = { DD_TRACE_ENABLED: false }
        handlers.get('APM_TRACING')(createApmTracingTransaction('test-config-2', conf))
        sinon.assert.called(appsec.disable)
        sinon.assert.called(iast.disable)

        conf = { DD_TRACE_ENABLED: true }
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

      it('registers the runtime metrics flush with the serverless lifecycle', () => {
        config.runtimeMetrics.enabled = true
        const done = sinon.spy()

        proxy.init()
        registerTelemetryFlusher.firstCall.args[0](done)

        sinon.assert.calledOnceWithExactly(runtimeMetrics.flush, done)
      })

      it('registers Vercel telemetry retention when tracing is disabled', () => {
        config.DD_TRACE_ENABLED = false

        proxy.init()

        sinon.assert.calledOnce(initializeServerlessTelemetry)
        const telemetry = initializeServerlessTelemetry.firstCall.args[0]
        assert.strictEqual(typeof telemetry.flushAll, 'function')
        const done = sinon.spy()
        telemetry.flushAll(done)
        sinon.assert.calledOnceWithExactly(flushServerlessTelemetry, done, undefined)
      })

      it('does not create a lifecycle owner outside a retention platform', () => {
        supportsServerlessTelemetryRetention.returns(false)
        proxy = new ProxyClass()

        proxy.init()

        assert.strictEqual(proxy._serverlessTelemetry, undefined)
        sinon.assert.calledWithExactly(initializeServerlessTelemetry, undefined)
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
          port: 9876,
        }
        config.tags = {
          service: 'photos',
          env: 'prod',
          version: '1.2.3',
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
        config.profiling = { DD_PROFILING_ENABLED: false }

        proxy.init()

        sinon.assert.notCalled(profiler.start)
      })

      it('should not load the profiler when profiling config does not exist', () => {
        config.pro_fil_ing = 'invalidConfig'

        proxy.init()

        sinon.assert.notCalled(profiler.start)
      })

      it('should load profiler when configured', () => {
        config.profiling = { DD_PROFILING_ENABLED: 'true' }

        proxy.init()

        sinon.assert.called(profiler.start)
      })

      it('should throw an error since profiler fails to be imported', () => {
        config.profiling = { DD_PROFILING_ENABLED: 'true' }

        const ProfilerImportFailureProxy = proxyquire('../src/proxy', {
          './tracer': DatadogTracer,
          './noop/tracer': NoopTracer,
          './config': Config,
          './runtime_metrics': runtimeMetrics,
          './log': log,
          './profiler': null, // this will cause the import failure error
          './appsec': appsec,
          './telemetry': telemetry,
          './remote_config': RemoteConfig,
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
          configure: sinon.stub(),
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
          './telemetry': telemetry,
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
      it('should call the underlying NoopTracer without exposing its return value', () => {
        const returnValue = proxy.inject('a', 'b', 'c')

        sinon.assert.calledWith(noop.inject, 'a', 'b', 'c')
        assert.strictEqual(returnValue, undefined)
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

        it('should not replace the store on invalid keys', () => {
          proxy.setBaggageItem('key', 'value')
          const before = proxy.getAllBaggageItems()
          proxy.removeBaggageItem(null)
          proxy.removeBaggageItem(123)
          proxy.removeBaggageItem('')
          assert.strictEqual(proxy.getAllBaggageItems(), before)
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

      describe('immutability', () => {
        it('should freeze every store handed out', () => {
          const allItems = proxy.getAllBaggageItems()
          assert.ok(Object.isFrozen(allItems), `Expected frozen, got ${inspect(allItems)}`)
          const setItem = proxy.setBaggageItem('key', 'value')
          assert.ok(Object.isFrozen(setItem), `Expected frozen, got ${inspect(setItem)}`)
          const removeItem = proxy.removeBaggageItem('key')
          assert.ok(Object.isFrozen(removeItem), `Expected frozen, got ${inspect(removeItem)}`)
          const removeAll = proxy.removeAllBaggageItems()
          assert.ok(Object.isFrozen(removeAll), `Expected frozen, got ${inspect(removeAll)}`)
        })

        it('should refuse mutation through the returned reference', () => {
          const baggage = proxy.setBaggageItem('key', 'value')
          assert.throws(() => { baggage.key = 'tampered' }, TypeError)
          assert.throws(() => { baggage.added = 'value' }, TypeError)
          assert.deepStrictEqual(proxy.getAllBaggageItems(), { key: 'value' })
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
      it('should call the underlying DatadogTracer without exposing its return value', () => {
        const returnValue = proxy.inject('a', 'b', 'c')

        sinon.assert.calledWith(tracer.inject, 'a', 'b', 'c')
        assert.strictEqual(returnValue, undefined)
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

  describe('MicroVM identity reset', () => {
    let channelMock
    let diagnosticsChannelMock
    let microProxy
    let storeConfig
    let uuidStub
    let buildProxy

    beforeEach(() => {
      uuidStub = sinon.stub().returns('00000000-0000-4000-8000-000000000000')

      channelMock = {
        subscribe: sinon.stub(),
        unsubscribe: sinon.stub(),
        publish: sinon.stub(),
      }

      diagnosticsChannelMock = {
        channel: sinon.stub().returns(channelMock),
      }
      storeConfig = sinon.stub().returns({})

      buildProxy = (nodeBundlesOpenssl = false) => new (proxyquire('../src/proxy', {
        './tracer': DatadogTracer,
        './noop/proxy': NoopProxy,
        './config': Config,
        './plugin_manager': PluginManager,
        './runtime_metrics': runtimeMetrics,
        './log': log,
        './profiler': profiler,
        './tracer_metadata': storeConfig,
        './serverless': {
          IS_AWS_LAMBDA_MICROVM: true,
          IS_SERVERLESS: true,
          NODE_BUNDLES_OPENSSL: nodeBundlesOpenssl,
        },
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
        './openfeature/flagging_provider': OpenFeatureProvider,
        'dc-polyfill': diagnosticsChannelMock,
        '../../../vendor/dist/crypto-randomuuid': uuidStub,
      }))()

      microProxy = buildProxy()
    })

    it('should register the MicroVM hook when env var is set', () => {
      microProxy.init()

      sinon.assert.calledWith(diagnosticsChannelMock.channel, 'http.server.request.start')
      sinon.assert.calledOnce(channelMock.subscribe)
    })

    it('should keep the MicroVM identity refresh when tracer initialization fails', () => {
      const error = new Error('tracer initialization failed')
      DatadogTracer.throws(error)

      microProxy.init()

      const subscriber = channelMock.subscribe.firstCall.args[0]
      subscriber({ request: { method: 'POST', url: '/aws/lambda-microvms/runtime/v1/run' } })

      sinon.assert.calledTwice(channelMock.publish)
      sinon.assert.alwaysCalledWithExactly(channelMock.publish, config)
      sinon.assert.notCalled(storeConfig)
      sinon.assert.calledOnceWithExactly(log.error, 'Error initializing tracer', error)
    })

    it('should not store tracer metadata when tracing is disabled', () => {
      config.DD_TRACE_ENABLED = false
      microProxy.init()

      const subscriber = channelMock.subscribe.firstCall.args[0]
      subscriber({ request: { method: 'POST', url: '/aws/lambda-microvms/runtime/v1/run' } })

      sinon.assert.notCalled(storeConfig)
      sinon.assert.calledTwice(channelMock.publish)
    })

    it('should publish datadog:identity:update with the tracer config on POST .../run', () => {
      microProxy.init()

      const subscriber = channelMock.subscribe.firstCall.args[0]
      sinon.assert.notCalled(channelMock.publish)

      subscriber({ request: { method: 'POST', url: '/aws/lambda-microvms/runtime/v1/run' } })

      sinon.assert.calledWith(diagnosticsChannelMock.channel, 'datadog:identity:update')
      sinon.assert.calledWith(diagnosticsChannelMock.channel, 'datadog:identity:refresh')
      sinon.assert.calledTwice(channelMock.publish)
      sinon.assert.alwaysCalledWithExactly(channelMock.publish, config)
    })

    it('should update identity, store metadata, and then refresh consumers', () => {
      // Core identity producers (id/config/remote_config) self-subscribe to identity:update and
      // must finish reseeding before identity:refresh notifies downstream cache-holders
      // (dogstatsd, otel metrics, debugger); otherwise those subsystems would refresh from the
      // pre-reseed identity.
      storeConfig.returns(undefined)
      microProxy.init()

      const subscriber = channelMock.subscribe.firstCall.args[0]
      subscriber({ request: { method: 'POST', url: '/aws/lambda-microvms/runtime/v1/run' } })

      const channelNames = diagnosticsChannelMock.channel.getCalls().map(call => call.args[0])
      const updateIndex = channelNames.indexOf('datadog:identity:update')
      const refreshIndex = channelNames.indexOf('datadog:identity:refresh')

      assert.notStrictEqual(updateIndex, -1)
      assert.notStrictEqual(refreshIndex, -1)

      const updateCall = diagnosticsChannelMock.channel.getCall(updateIndex)
      const refreshCall = diagnosticsChannelMock.channel.getCall(refreshIndex)
      assert.ok(updateCall.callId < storeConfig.firstCall.callId)
      assert.ok(storeConfig.firstCall.callId < refreshCall.callId)
      sinon.assert.calledOnceWithExactly(log.warn, 'Could not store tracer configuration for service discovery')
    })

    it('should NOT fire refreshIdentity on GET /aws/lambda-microvms/runtime/v1/run', () => {
      microProxy.init()

      const subscriber = channelMock.subscribe.firstCall.args[0]
      subscriber({ request: { method: 'GET', url: '/aws/lambda-microvms/runtime/v1/run' } })

      sinon.assert.notCalled(channelMock.publish)
    })

    it('should NOT fire refreshIdentity on POST /other', () => {
      microProxy.init()

      const subscriber = channelMock.subscribe.firstCall.args[0]
      subscriber({ request: { method: 'POST', url: '/other' } })

      sinon.assert.notCalled(channelMock.publish)
    })

    it('should log an error at registration when Node bundles its own OpenSSL', () => {
      buildProxy(true).init()

      sinon.assert.calledOnce(log.error)
      assert.match(log.error.firstCall.args[0], /bundles its own OpenSSL/)
    })

    it('should not log an error when Node links a shared OpenSSL', () => {
      microProxy.init()

      sinon.assert.notCalled(log.error)
    })

    it('should drain a full UUID batch before publishing datadog:identity:update', () => {
      microProxy.init()

      const subscriber = channelMock.subscribe.firstCall.args[0]
      sinon.assert.notCalled(uuidStub)

      subscriber({ request: { method: 'POST', url: '/aws/lambda-microvms/runtime/v1/run' } })

      // a full batch, so the pool's cursor wraps and refills wherever the snapshot froze it
      sinon.assert.callCount(uuidStub, 128)

      const updateIndex = diagnosticsChannelMock.channel.getCalls()
        .findIndex(call => call.args[0] === 'datadog:identity:update')
      const updateCall = diagnosticsChannelMock.channel.getCall(updateIndex)

      assert.ok(uuidStub.lastCall.callId < updateCall.callId)
    })

    it('should not drain the UUID pool when the request is not the run hook', () => {
      microProxy.init()

      const subscriber = channelMock.subscribe.firstCall.args[0]
      subscriber({ request: { method: 'GET', url: '/aws/lambda-microvms/runtime/v1/run' } })
      subscriber({ request: { method: 'POST', url: '/other' } })

      sinon.assert.notCalled(uuidStub)
    })

    it('should unsubscribe HTTP channel after first fire', () => {
      microProxy.init()

      const subscriber = channelMock.subscribe.firstCall.args[0]
      subscriber({ request: { method: 'POST', url: '/aws/lambda-microvms/runtime/v1/run' } })

      sinon.assert.calledOnceWithExactly(channelMock.unsubscribe, subscriber)
    })
  })

  describe('MicroVM identity refresh (real modules)', () => {
    let RealConfig
    let RealRemoteConfig
    let udp4Send
    let MicroVmProxy
    let microProxy
    let capturedConfig
    let storedRuntimeId
    let storeConfig
    let server

    beforeEach(async () => {
      // Real (not proxied) config/remote_config/dogstatsd modules, so this test proves the
      // actual production wiring — not that mocks were called correctly.
      RealConfig = proxyquire.noPreserveCache()('../src/config', {})
      RealRemoteConfig = proxyquire.noPreserveCache()('../src/remote_config', {})

      udp4Send = sinon.spy()
      const udp4 = { send: udp4Send, on: sinon.stub(), unref: sinon.stub() }
      udp4.on.returns(udp4)
      udp4.unref.returns(udp4)
      const dgram = { createSocket: sinon.stub().returns(udp4) }
      const dns = { lookup: sinon.stub().callsFake((hostname, callback) => callback(null, hostname, 4)) }
      const RealCustomMetrics = proxyquire.noPreserveCache()('../src/dogstatsd', { dgram }).CustomMetrics

      storeConfig = sinon.stub().callsFake(metadataConfig => {
        storedRuntimeId = metadataConfig.tags['runtime-id']
        return {}
      })

      capturedConfig = null
      const CapturingConfig = (...args) => {
        capturedConfig = RealConfig(...args)
        capturedConfig.lookup = dns.lookup
        capturedConfig.runtimeMetricsRuntimeId = true
        // Force the UDP send path so this test can observe the outgoing packet directly,
        // instead of going through the HTTP-proxy-to-agent path config.url otherwise selects.
        capturedConfig.url = undefined
        return capturedConfig
      }

      MicroVmProxy = proxyquire('../src/proxy', {
        './tracer': DatadogTracer,
        './noop/proxy': NoopProxy,
        './config': CapturingConfig,
        './plugin_manager': PluginManager,
        './runtime_metrics': runtimeMetrics,
        './log': log,
        './profiler': profiler,
        './tracer_metadata': storeConfig,
        './serverless': {
          IS_AWS_LAMBDA_MICROVM: true,
          IS_SERVERLESS: true,
        },
        './appsec': appsec,
        './appsec/iast': iast,
        './telemetry': telemetry,
        './remote_config': RemoteConfig,
        './aiguard/sdk': AIGuardSdk,
        './appsec/sdk': AppsecSdk,
        './dogstatsd': { CustomMetrics: RealCustomMetrics },
        './noop/dogstatsd': NoopDogStatsDClient,
        './flare': flare,
        './openfeature': openfeature,
        './openfeature/flagging_provider': OpenFeatureProvider,
        // dc-polyfill intentionally NOT mocked — this test exercises the real shared channel.
      })

      microProxy = new MicroVmProxy()

      server = http.createServer((request, response) => {
        assert.strictEqual(request.method, 'POST')
        assert.strictEqual(request.url, '/aws/lambda-microvms/runtime/v1/run')
        response.end()
      })
      server.listen(0)
      await once(server, 'listening')
    })

    afterEach(async () => {
      const closed = once(server, 'close')
      server.close()
      await closed
    })

    it('refreshes config, remote config, and dogstatsd tags together on a real /run request', async () => {
      microProxy.init()

      // Constructed independently from the same real remote_config module proxy.js uses
      // internally — refreshClientId() mutates module-scoped state shared by every instance.
      const rc = new RealRemoteConfig(capturedConfig)
      const originalRuntimeId = capturedConfig.tags['runtime-id']
      const originalClientId = rc.state.client.id

      const customMetrics = microProxy.dogstatsd

      await triggerMicroVmRun(server)

      assert.notStrictEqual(capturedConfig.tags['runtime-id'], originalRuntimeId)
      assert.notStrictEqual(rc.state.client.id, originalClientId)

      customMetrics.gauge('test.metric', 1)
      customMetrics.flush()

      sinon.assert.called(udp4Send)
      const payload = udp4Send.firstCall.args[0].toString()
      assert.ok(
        payload.includes(`runtime-id:${capturedConfig.tags['runtime-id']}`),
        `expected refreshed runtime-id in payload, got: ${payload}`
      )
    })

    it('stores process metadata once with the refreshed /run identity', async () => {
      microProxy.init()

      const originalRuntimeId = capturedConfig.tags['runtime-id']
      sinon.assert.notCalled(storeConfig)

      await triggerMicroVmRun(server)
      await triggerMicroVmRun(server)

      sinon.assert.calledOnceWithExactly(storeConfig, capturedConfig)
      assert.notStrictEqual(storedRuntimeId, originalRuntimeId)
      assert.strictEqual(storedRuntimeId, capturedConfig.tags['runtime-id'])
    })
  })
})

/**
 * @param {import('node:http').Server} server
 */
async function triggerMicroVmRun (server) {
  await legacyStorage.run({ noop: true }, async () => {
    const { address, port } = server.address()
    const request = http.request({
      hostname: address === '::' ? '::1' : address,
      method: 'POST',
      path: '/aws/lambda-microvms/runtime/v1/run',
      port,
    })
    const responsePromise = once(request, 'response')
    request.end()

    const [response] = await responsePromise
    const end = once(response, 'end')
    response.resume()
    await end
  })
}

// Helper function to create APM_TRACING batch transaction objects
function createApmTracingTransaction (configId, libConfig, action = 'apply') {
  const item = {
    id: configId,
    file: { lib_config: libConfig },
    path: `datadog/1/APM_TRACING/${configId}`,
  }

  return {
    toUnapply: action === 'unapply' ? [item] : [],
    toApply: action === 'apply' ? [item] : [],
    toModify: action === 'modify' ? [item] : [],
    ack: sinon.spy(),
    error: sinon.spy(),
  }
}
