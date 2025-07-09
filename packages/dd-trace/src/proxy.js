'use strict'
const NoopProxy = require('./noop/proxy')
const DatadogTracer = require('./tracer')
const Config = require('./config')
const runtimeMetrics = require('./runtime_metrics')
const log = require('./log')
const { setStartupLogPluginManager } = require('./startup-log')
const DynamicInstrumentation = require('./debugger')
const telemetry = require('./telemetry')
const nomenclature = require('./service-naming')
const PluginManager = require('./plugin_manager')
const NoopDogStatsDClient = require('./noop/dogstatsd')
const { getEnvironmentVariable } = require('../../dd-trace/src/config-helper')
const {
  setBaggageItem,
  getBaggageItem,
  getAllBaggageItems,
  removeBaggageItem,
  removeAllBaggageItems
} = require('./baggage')

class LazyModule {
  constructor (provider) {
    this.provider = provider
  }

  enable (...args) {
    this.module = this.provider()
    this.module.enable(...args)
  }

  disable () {
    this.module?.disable()
  }
}

function lazyProxy (obj, property, config, getClass, ...args) {
  if (config?._isInServerlessEnvironment?.() === false) {
    defineEagerly(obj, property, getClass, ...args)
  } else {
    defineLazily(obj, property, getClass, ...args)
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
    enumerable: true
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
      iast: new LazyModule(() => require('./appsec/iast')),
      llmobs: new LazyModule(() => require('./llmobs')),
      rewriter: new LazyModule(() => require('./appsec/iast/taint-tracking/rewriter'))
    }
  }

  init (options) {
    if (this._initialized) return this

    this._initialized = true

    try {
      const config = new Config(options) // TODO: support dynamic code config

      if (config.crashtracking.enabled) {
        require('./crashtracking').start(config)
      }

      if (config.heapSnapshot.count > 0) {
        require('./heap_snapshots').start(config)
      }

      telemetry.start(config, this._pluginManager)

      if (config.dogstatsd) {
        // Custom Metrics
        lazyProxy(this, 'dogstatsd', config, () => require('./dogstatsd').CustomMetrics, config)
      }

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
        const rc = require('./remote_config').enable(config, this._modules.appsec)

        rc.setProductHandler('APM_TRACING', (action, conf) => {
          if (action === 'unapply') {
            config.configure({}, true)
          } else {
            config.configure(conf.lib_config, true)
          }
          this._enableOrDisableTracing(config)
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

        if (config.dynamicInstrumentation.enabled) {
          DynamicInstrumentation.start(config, rc)
        }
      }

      if (config.profiling.enabled === 'true') {
        this._profilerStarted = this._startProfiler(config)
      } else {
        this._profilerStarted = Promise.resolve(false)
        if (config.profiling.enabled === 'auto') {
          const { SSIHeuristics } = require('./profiling/ssi-heuristics')
          const ssiHeuristics = new SSIHeuristics(config)
          ssiHeuristics.start()
          ssiHeuristics.onTriggered(() => {
            this._startProfiler(config)
            ssiHeuristics.onTriggered() // deregister this callback
          })
        }
      }

      if (config.runtimeMetrics.enabled) {
        runtimeMetrics.start(config)
      }

      this._enableOrDisableTracing(config)

      this._modules.rewriter.enable(config)

      if (config.tracing && config.isManualApiEnabled) {
        const TestApiManualPlugin = require('./ci-visibility/test-api-manual/test-api-manual-plugin')
        this._testApiManualPlugin = new TestApiManualPlugin(this)
        // `shouldGetEnvironmentData` is passed as false so that we only lazily calculate it
        // This is the only place where we need to do this because the rest of the plugins
        // are lazily configured when the library is imported.
        this._testApiManualPlugin.configure({ ...config, enabled: true }, false)
      }
      if (config.ciVisAgentlessLogSubmissionEnabled) {
        if (getEnvironmentVariable('DD_API_KEY')) {
          const LogSubmissionPlugin = require('./ci-visibility/log-submission/log-submission-plugin')
          const automaticLogPlugin = new LogSubmissionPlugin(this)
          automaticLogPlugin.configure({ ...config, enabled: true })
        } else {
          log.warn(
            // eslint-disable-next-line @stylistic/max-len
            'DD_AGENTLESS_LOG_SUBMISSION_ENABLED is set, but DD_API_KEY is undefined, so no automatic log submission will be performed.'
          )
        }
      }

      if (config.isTestDynamicInstrumentationEnabled) {
        const getDynamicInstrumentationClient = require('./ci-visibility/dynamic-instrumentation')
        // We instantiate the client but do not start the Worker here. The worker is started lazily
        getDynamicInstrumentationClient(config)
      }
    } catch (e) {
      log.error('Error initialising tracer', e)
    }

    return this
  }

  _startProfiler (config) {
    // do not stop tracer initialization if the profiler fails to be imported
    try {
      return require('./profiler').start(config)
    } catch (e) {
      log.error(
        'Error starting profiler. For troubleshooting tips, see <https://dtdg.co/nodejs-profiler-troubleshooting>',
        e
      )
    }
  }

  _enableOrDisableTracing (config) {
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
        this._tracer = new DatadogTracer(config, prioritySampler)
        this.dataStreamsCheckpointer = this._tracer.dataStreamsCheckpointer
        lazyProxy(this, 'appsec', config, () => require('./appsec/sdk'), this._tracer, config)
        lazyProxy(this, 'llmobs', config, () => require('./llmobs/sdk'), this._tracer, this._modules.llmobs, config)
        this._tracingInitialized = true
      }
      if (config.iast.enabled) {
        this._modules.iast.enable(config, this._tracer)
      }
      // This needs to be after the IAST module is enabled
    } else if (this._tracingInitialized) {
      this._modules.appsec.disable()
      this._modules.iast.disable()
      this._modules.llmobs.disable()
    }

    if (this._tracingInitialized) {
      this._tracer.configure(config)
      this._pluginManager.configure(config)
      DynamicInstrumentation.configure(config)
      setStartupLogPluginManager(this._pluginManager)
    }
  }

  profilerStarted () {
    if (!this._profilerStarted) {
      // injection hardening: this is only ever invoked from tests.
      throw new Error('profilerStarted() must be called after init()')
    }
    return this._profilerStarted
  }

  use () {
    this._pluginManager.configurePlugin(...arguments)
    return this
  }

  get TracerProvider () {
    return require('./opentelemetry/tracer_provider')
  }
}

module.exports = Tracer
