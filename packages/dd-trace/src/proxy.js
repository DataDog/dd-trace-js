'use strict'
const NoopProxy = require('./noop/proxy')
const DatadogTracer = require('./tracer')
const Config = require('./config')
const runtimeMetrics = require('./runtime_metrics')
const log = require('./log')
const { setStartupLogPluginManager } = require('./startup-log')
const telemetry = require('./telemetry')
const nomenclature = require('./service-naming')
const PluginManager = require('./plugin_manager')
const remoteConfig = require('./appsec/remote_config')
const AppsecSdk = require('./appsec/sdk')
const dogstatsd = require('./dogstatsd')
const NoopDogStatsDClient = require('./noop/dogstatsd')
const spanleak = require('./spanleak')
const { SSIHeuristics } = require('./profiling/ssi-heuristics')
const telemetryLog = require('dc-polyfill').channel('datadog:telemetry:log')

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

class Tracer extends NoopProxy {
  constructor () {
    super()

    this._initialized = false
    this._nomenclature = nomenclature
    this._pluginManager = new PluginManager(this)
    this.dogstatsd = new NoopDogStatsDClient()
    this._tracingInitialized = false
    this._flare = new LazyModule(() => require('./flare'))

    // these requires must work with esm bundler
    this._modules = {
      appsec: new LazyModule(() => require('./appsec')),
      iast: new LazyModule(() => require('./appsec/iast'))
    }
  }

  init (options) {
    if (this._initialized) return this

    this._initialized = true

    try {
      const config = new Config(options) // TODO: support dynamic code config
      telemetry.start(config, this._pluginManager)

      if (config.dogstatsd) {
        // Custom Metrics
        this.dogstatsd = new dogstatsd.CustomMetrics(config)

        setInterval(() => {
          this.dogstatsd.flush()
        }, 10 * 1000).unref()

        process.once('beforeExit', () => {
          this.dogstatsd.flush()
        })
      }

      if (config.spanLeakDebug > 0) {
        if (config.spanLeakDebug === spanleak.MODES.LOG) {
          spanleak.enableLogging()
        } else if (config.spanLeakDebug === spanleak.MODES.GC_AND_LOG) {
          spanleak.enableGarbageCollection()
        }
        spanleak.startScrubber()
      }

      if (config.remoteConfig.enabled && !config.isCiVisibility) {
        const rc = remoteConfig.enable(config, this._modules.appsec)

        rc.on('APM_TRACING', (action, conf) => {
          if (action === 'unapply') {
            config.configure({}, true)
          } else {
            config.configure(conf.lib_config, true)
          }
          this._enableOrDisableTracing(config)
        })

        rc.on('AGENT_CONFIG', (action, conf) => {
          if (!conf?.name?.startsWith('flare-log-level.')) return

          if (action === 'unapply') {
            this._flare.disable()
          } else if (conf.config?.log_level) {
            this._flare.enable(config)
            this._flare.module.prepare(conf.config.log_level)
          }
        })

        rc.on('AGENT_TASK', (action, conf) => {
          if (action === 'unapply' || !conf) return
          if (conf.task_type !== 'tracer_flare' || !conf.args) return

          this._flare.enable(config)
          this._flare.module.send(conf.args)
        })
      }

      if (config.isGCPFunction || config.isAzureFunction) {
        require('./serverless').maybeStartServerlessMiniAgent(config)
      }

      const ssiHeuristics = new SSIHeuristics(config.profiling)
      ssiHeuristics.start()
      if (config.profiling.enabled) {
        this._profilerStarted = this._startProfiler(config)
      } else if (config.profiling.ssi) {
        const mockProfiler = require('./profiling/ssi-telemetry-mock-profiler')
        mockProfiler.start(config)

        if (config.profiling.heuristicsEnabled) {
          ssiHeuristics.onTriggered(() => {
            mockProfiler.stop()
            this._startProfiler(config)
            ssiHeuristics.onTriggered()
          })
        }
      }
      if (!this._profilerStarted) {
        this._profilerStarted = Promise.resolve(false)
      }

      if (config.runtimeMetrics) {
        runtimeMetrics.start(config)
      }

      this._enableOrDisableTracing(config)

      if (config.tracing) {
        if (config.isManualApiEnabled) {
          const TestApiManualPlugin = require('./ci-visibility/test-api-manual/test-api-manual-plugin')
          this._testApiManualPlugin = new TestApiManualPlugin(this)
          this._testApiManualPlugin.configure({ ...config, enabled: true })
        }
      }
    } catch (e) {
      log.error(e)
    }

    return this
  }

  _startProfiler (config) {
    // do not stop tracer initialization if the profiler fails to be imported
    try {
      return require('./profiler').start(config)
    } catch (e) {
      log.error(e)
      if (telemetryLog.hasSubscribers) {
        telemetryLog.publish({
          message: e.message,
          level: 'ERROR',
          stack_trace: e.stack
        })
      }
    }
  }

  _enableOrDisableTracing (config) {
    if (config.tracing !== false) {
      if (config.appsec.enabled) {
        this._modules.appsec.enable(config)
      }
      if (!this._tracingInitialized) {
        this._tracer = new DatadogTracer(config)
        this.appsec = new AppsecSdk(this._tracer, config)
        this._tracingInitialized = true
      }
      if (config.iast.enabled) {
        this._modules.iast.enable(config, this._tracer)
      }
    } else if (this._tracingInitialized) {
      this._modules.appsec.disable()
      this._modules.iast.disable()
    }

    if (this._tracingInitialized) {
      this._tracer.configure(config)
      this._pluginManager.configure(config)
      setStartupLogPluginManager(this._pluginManager)
    }
  }

  profilerStarted () {
    if (!this._profilerStarted) {
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
