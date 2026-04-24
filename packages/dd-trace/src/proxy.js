'use strict'

function _dbgInit (label) {
  const t = process._tracerInitStart || Date.now()
  process.stderr.write(`[proxy.init +${Date.now() - t}ms] ${label}\n`)
}
const NoopProxy = require('./noop/proxy')
const DatadogTracer = require('./tracer')
const getConfig = require('./config')
const runtimeMetrics = require('./runtime_metrics')
const log = require('./log')
const { setStartupLogPluginManager, startupLog } = require('./startup-log')
const DynamicInstrumentation = require('./debugger')
const telemetry = require('./telemetry')
const nomenclature = require('./service-naming')
const PluginManager = require('./plugin_manager')
const NoopDogStatsDClient = require('./noop/dogstatsd')
const { IS_SERVERLESS } = require('./serverless')
const processTags = require('./process-tags')
const {
  setBaggageItem,
  getBaggageItem,
  getAllBaggageItems,
  removeBaggageItem,
  removeAllBaggageItems,
} = require('./baggage')

class LazyModule {
  constructor (provider) {
    this.provider = provider
  }

  /**
   * @param {import('./config/config-base')} config - Tracer configuration
   */
  enable (config, ...args) {
    this.module = this.provider()
    this.module.enable(config, ...args)
  }

  disable () {
    this.module?.disable()
  }
}

function lazyProxy (...args) {
  if (IS_SERVERLESS === false) {
    defineEagerly(...args)
  } else {
    defineLazily(...args)
  }
}

function defineEagerly (obj, property, getClass, ...args) {
  const RealClass = getClass()

  obj[property] = new RealClass(...args)
}

function defineLazily (obj, property, getClass, ...args) {
  Reflect.defineProperty(obj, property, {
    get () {
      const RealClass = getClass()
      const value = new RealClass(...args)

      Reflect.defineProperty(obj, property, { value, configurable: true, enumerable: true })

      return value
    },
    configurable: true,
    enumerable: true,
  })
}

class Tracer extends NoopProxy {
  constructor () {
    super()

    this._initialized = false
    this._nomenclature = nomenclature
    this._pluginManager = new PluginManager(this)
    this.dogstatsd = new NoopDogStatsDClient()
    this._tracingInitialized = false
    this._flare = new LazyModule(() => require('./flare'))
    this.setBaggageItem = setBaggageItem
    this.getBaggageItem = getBaggageItem
    this.getAllBaggageItems = getAllBaggageItems
    this.removeBaggageItem = removeBaggageItem
    this.removeAllBaggageItems = removeAllBaggageItems

    // these requires must work with esm bundler
    this._modules = {
      appsec: new LazyModule(() => require('./appsec')),
      aiguard: new LazyModule(() => require('./aiguard')),
      iast: new LazyModule(() => require('./appsec/iast')),
      llmobs: new LazyModule(() => require('./llmobs')),
      rewriter: new LazyModule(() => require('./appsec/iast/taint-tracking/rewriter')),
      openfeature: new LazyModule(() => require('./openfeature')),
    }
  }

  /**
   * @override
   */
  init (options) {
    if (this._initialized) return this

    this._initialized = true

    process._tracerInitStart = Date.now()

    _dbgInit('start')

    try {
      const config = getConfig(options) // TODO: support dynamic code config
      _dbgInit('after getConfig')

      // Add config dependent process tags
      processTags.initialize(config)
      _dbgInit('after processTags.initialize')

      // Configure propagation hash manager for process tags + container tags
      const propagationHash = require('./propagation-hash')
      propagationHash.configure(config)
      _dbgInit('after propagationHash.configure')

      if (config.crashtracking.enabled) {
        require('./crashtracking').start(config)
      }

      if (config.heapSnapshot.count > 0) {
        require('./heap_snapshots').start(config)
      }

      telemetry.start(config, this._pluginManager)
      _dbgInit('after telemetry.start')

      if (config.dogstatsd) {
        // Custom Metrics
        lazyProxy(this, 'dogstatsd', () => require('./dogstatsd').CustomMetrics, config)
      }
      _dbgInit('after dogstatsd setup')

      if (config.spanLeakDebug > 0) {
        const spanleak = require('./spanleak')
        if (config.spanLeakDebug === spanleak.MODES.LOG) {
          spanleak.enableLogging()
        } else if (config.spanLeakDebug === spanleak.MODES.GC_AND_LOG) {
          spanleak.enableGarbageCollection()
        }
        spanleak.startScrubber()
      }

      if (config.remoteConfig.enabled && !config.isCiVisibility) {
        _dbgInit('remoteConfig: require start')
        const RemoteConfig = require('./remote_config')
        _dbgInit('remoteConfig: new RemoteConfig start')
        const rc = new RemoteConfig(config)
        _dbgInit('remoteConfig: new RemoteConfig done')

        const tracingRemoteConfig = require('./config/remote_config')
        tracingRemoteConfig.enable(rc, config, () => {
          this.#updateTracing(config)
          this.#updateDebugger(config, rc)
        })

        rc.setProductHandler('AGENT_CONFIG', (action, conf) => {
          if (!conf?.name?.startsWith('flare-log-level.')) return

          if (action === 'unapply') {
            this._flare.disable()
          } else if (conf.config?.log_level) {
            this._flare.enable(config)
            this._flare.module.prepare(conf.config.log_level)
          }
        })

        rc.setProductHandler('AGENT_TASK', (action, conf) => {
          if (action === 'unapply' || !conf) return
          if (conf.task_type !== 'tracer_flare' || !conf.args) return

          this._flare.enable(config)
          this._flare.module.send(conf.args)
        })

        if (this._modules.appsec) {
          const appsecRemoteConfig = require('./appsec/remote_config')
          appsecRemoteConfig.enable(rc, config, this._modules.appsec)
        }

        if (config.dynamicInstrumentation.enabled) {
          DynamicInstrumentation.start(config, rc)
        }

        const openfeatureRemoteConfig = require('./openfeature/remote_config')
        openfeatureRemoteConfig.enable(rc, config, () => this.openfeature)
        _dbgInit('remoteConfig: done')
      }

      if (config.profiling.enabled === 'true') {
        this._profilerStarted = this._startProfiler(config)
      } else {
        this._profilerStarted = false
        if (config.profiling.enabled === 'auto') {
          _dbgInit('SSIHeuristics: start')
          const { SSIHeuristics } = require('./profiling/ssi-heuristics')
          const ssiHeuristics = new SSIHeuristics(config)
          ssiHeuristics.start()
          _dbgInit('SSIHeuristics: done')
          ssiHeuristics.onTriggered(() => {
            this._startProfiler(config)
            ssiHeuristics.onTriggered() // deregister this callback
          })
        }
      }
      _dbgInit('after profiling setup')

      if (config.runtimeMetrics.enabled) {
        _dbgInit('runtimeMetrics.start: start')
        runtimeMetrics.start(config)
        _dbgInit('runtimeMetrics.start: done')
      }

      _dbgInit('before #updateTracing')
      this.#updateTracing(config)
      _dbgInit('after #updateTracing')

      this._modules.rewriter.enable(config)
      _dbgInit('after rewriter.enable')

      if (config.tracing && config.isManualApiEnabled) {
        _dbgInit('testApiManualPlugin: start')
        const TestApiManualPlugin = require('./ci-visibility/test-api-manual/test-api-manual-plugin')
        this._testApiManualPlugin = new TestApiManualPlugin(this)
        // `shouldGetEnvironmentData` is passed as false so that we only lazily calculate it
        // This is the only place where we need to do this because the rest of the plugins
        // are lazily configured when the library is imported.
        this._testApiManualPlugin.configure({ ...config, enabled: true }, false)
        _dbgInit('testApiManualPlugin: done')
      }
      if (config.ciVisAgentlessLogSubmissionEnabled) {
        if (config.apiKey) {
          _dbgInit('logSubmissionPlugin: start')
          const LogSubmissionPlugin = require('./ci-visibility/log-submission/log-submission-plugin')
          const automaticLogPlugin = new LogSubmissionPlugin(this)
          automaticLogPlugin.configure({ ...config, enabled: true })
          _dbgInit('logSubmissionPlugin: done')
        } else {
          log.warn(
            // eslint-disable-next-line @stylistic/max-len
            'DD_AGENTLESS_LOG_SUBMISSION_ENABLED is set, but DD_API_KEY is undefined, so no automatic log submission will be performed.'
          )
        }
      }

      if (config.otelLogsEnabled) {
        _dbgInit('otelLogs: start')
        const { initializeOpenTelemetryLogs } = require('./opentelemetry/logs')
        initializeOpenTelemetryLogs(config)
        _dbgInit('otelLogs: done')
      }

      if (config.otelMetricsEnabled) {
        _dbgInit('otelMetrics: start')
        const { initializeOpenTelemetryMetrics } = require('./opentelemetry/metrics')
        initializeOpenTelemetryMetrics(config)
        _dbgInit('otelMetrics: done')
      }

      if (config.isTestDynamicInstrumentationEnabled) {
        _dbgInit('testDynamicInstrumentation: start')
        const getDynamicInstrumentationClient = require('./ci-visibility/dynamic-instrumentation')
        // We instantiate the client but do not start the Worker here. The worker is started lazily
        getDynamicInstrumentationClient(config)
        _dbgInit('testDynamicInstrumentation: done')
      }

      _dbgInit('done')
    } catch (e) {
      log.error('Error initializing tracer', e)
      // TODO: Should we stop everything started so far?
    }

    return this
  }

  /**
   * @param {import('./config/config-base')} config - Tracer configuration
   */
  _startProfiler (config) {
    // do not stop tracer initialization if the profiler fails to be imported
    try {
      return require('./profiler').start(config)
    } catch (error) {
      log.error(
        'Error starting profiler. For troubleshooting tips, see <https://dtdg.co/nodejs-profiler-troubleshooting>',
        error
      )
      return false
    }
  }

  /**
   * @param {import('./config/config-base')} config - Tracer configuration
   */
  #updateTracing (config) {
    if (config.tracing !== false) {
      if (config.appsec.enabled) {
        this._modules.appsec.enable(config)
      }
      if (config.llmobs.enabled) {
        this._modules.llmobs.enable(config)
      }
      if (!this._tracingInitialized) {
        const prioritySampler = config.apmTracingEnabled === false
          ? require('./standalone').configure(config)
          : undefined
        _dbgInit('before new DatadogTracer')
        this._tracer = new DatadogTracer(config, prioritySampler)
        _dbgInit('after new DatadogTracer')
        this.dataStreamsCheckpointer = this._tracer.dataStreamsCheckpointer
        lazyProxy(this, 'appsec', () => require('./appsec/sdk'), this._tracer, config)
        lazyProxy(this, 'llmobs', () => require('./llmobs/sdk'), this._tracer, this._modules.llmobs, config)
        _dbgInit('after lazyProxy appsec/llmobs')

        if (config.experimental?.aiguard?.enabled) {
          this._modules.aiguard.enable(this._tracer, config)
          lazyProxy(this, 'aiguard', () => require('./aiguard/sdk'), this._tracer, config)
        }
        this._tracingInitialized = true
      }
      if (config.experimental.flaggingProvider.enabled) {
        this._modules.openfeature.enable(config)
        lazyProxy(this, 'openfeature', () => require('./openfeature/flagging_provider'), this._tracer, config)
      }
      _dbgInit('after flaggingProvider')
      if (config.iast.enabled) {
        _dbgInit('iast.enable start')
        this._modules.iast.enable(config, this._tracer)
        _dbgInit('iast.enable done')
      }
      // This needs to be after the IAST module is enabled
    } else if (this._tracingInitialized) {
      this._modules.appsec.disable()
      this._modules.aiguard.disable()
      this._modules.iast.disable()
      this._modules.llmobs.disable()
      this._modules.openfeature.disable()
    }

    if (this._tracingInitialized) {
      _dbgInit('tracer.configure start')
      this._tracer.configure(config)
      _dbgInit('pluginManager.configure start')
      this._pluginManager.configure(config)
      _dbgInit('pluginManager.configure done')
      DynamicInstrumentation.configure(config)
      setStartupLogPluginManager(this._pluginManager)
      startupLog()
      _dbgInit('done')
    }
  }

  /**
   * Updates the debugger (Dynamic Instrumentation) state based on remote config changes.
   * Handles starting, stopping, and reconfiguring the debugger dynamically.
   *
   * @param {object} config - The tracer configuration object
   * @param {object} rc - The RemoteConfig instance
   */
  #updateDebugger (config, rc) {
    const shouldBeEnabled = config.dynamicInstrumentation.enabled
    const isCurrentlyStarted = DynamicInstrumentation.isStarted()

    if (shouldBeEnabled) {
      if (isCurrentlyStarted) {
        log.debug('[proxy] Reconfiguring Dynamic Instrumentation via remote config')
        DynamicInstrumentation.configure(config)
      } else {
        log.debug('[proxy] Starting Dynamic Instrumentation via remote config')
        DynamicInstrumentation.start(config, rc)
      }
    } else if (isCurrentlyStarted) {
      log.debug('[proxy] Stopping Dynamic Instrumentation via remote config')
      DynamicInstrumentation.stop()
    }
  }

  /**
   * @override
   */
  get profiling () {
    // Lazily require the profiler module and cache the result. If profiling
    // is not enabled, runWithLabels still works as a passthrough (just calls fn()).
    const profilerModule = require('./profiler')
    const profiling = {
      setCustomLabelKeys (keys) {
        profilerModule.setCustomLabelKeys(keys)
      },
      runWithLabels (labels, fn) {
        return profilerModule.runWithLabels(labels, fn)
      },
    }
    Reflect.defineProperty(this, 'profiling', { value: profiling, configurable: true, enumerable: true })
    return profiling
  }

  /**
   * @override
   */
  profilerStarted () {
    if (this._profilerStarted === undefined) {
      // injection hardening: this is only ever invoked from tests.
      throw new Error('profilerStarted() must be called after init()')
    }
    return Promise.resolve(this._profilerStarted)
  }

  /**
   * @override
   */
  use () {
    this._pluginManager.configurePlugin(...arguments)
    return this
  }

  /**
   * @override
   */
  get TracerProvider () {
    return require('./opentelemetry/tracer_provider')
  }
}

module.exports = Tracer
