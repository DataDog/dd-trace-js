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
const remoteConfig = require('./appsec/remote_config')
const AppsecSdk = require('./appsec/sdk')
const dogstatsd = require('./dogstatsd')
const NoopDogStatsDClient = require('./noop/dogstatsd')
const spanleak = require('./spanleak')
const { SSIHeuristics } = require('./profiling/ssi-heuristics')
const appsecStandalone = require('./appsec/standalone')
const LLMObsSDK = require('./llmobs/sdk')

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
      iast: new LazyModule(() => require('./appsec/iast')),
      llmobs: new LazyModule(() => require('./llmobs'))
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

      if (config.isGCPFunction || config.isAzureFunction) {
        require('./serverless').maybeStartServerlessMiniAgent(config)
      }

      if (config.profiling.enabled !== 'false') {
        const ssiHeuristics = new SSIHeuristics(config)
        ssiHeuristics.start()
        let mockProfiler = null
        if (config.profiling.enabled === 'true') {
          this._profilerStarted = this._startProfiler(config)
        } else if (ssiHeuristics.emitsTelemetry) {
          // Start a mock profiler that emits mock profile-submitted events for the telemetry.
          // It will be stopped if the real profiler is started by the heuristics.
          mockProfiler = require('./profiling/ssi-telemetry-mock-profiler')
          mockProfiler.start(config)
        }

        if (ssiHeuristics.heuristicsActive) {
          ssiHeuristics.onTriggered(() => {
            if (mockProfiler) {
              mockProfiler.stop()
            }
            this._startProfiler(config)
            ssiHeuristics.onTriggered() // deregister this callback
          })
        }

        if (!this._profilerStarted) {
          this._profilerStarted = Promise.resolve(false)
        }
      }

      if (config.runtimeMetrics) {
        runtimeMetrics.start(config)
      }

      this._enableOrDisableTracing(config)

      if (config.tracing) {
        if (config.isManualApiEnabled) {
          const TestApiManualPlugin = require('./ci-visibility/test-api-manual/test-api-manual-plugin')
          this._testApiManualPlugin = new TestApiManualPlugin(this)
          // `shouldGetEnvironmentData` is passed as false so that we only lazily calculate it
          // This is the only place where we need to do this because the rest of the plugins
          // are lazily configured when the library is imported.
          this._testApiManualPlugin.configure({ ...config, enabled: true }, false)
        }
      }
      if (config.ciVisAgentlessLogSubmissionEnabled) {
        if (process.env.DD_API_KEY) {
          const LogSubmissionPlugin = require('./ci-visibility/log-submission/log-submission-plugin')
          const automaticLogPlugin = new LogSubmissionPlugin(this)
          automaticLogPlugin.configure({ ...config, enabled: true })
        } else {
          log.warn(
            'DD_AGENTLESS_LOG_SUBMISSION_ENABLED is set, ' +
            'but DD_API_KEY is undefined, so no automatic log submission will be performed.'
          )
        }
      }

      if (config.isTestDynamicInstrumentationEnabled) {
        const testVisibilityDynamicInstrumentation = require('./ci-visibility/dynamic-instrumentation')
        testVisibilityDynamicInstrumentation.start(config)
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
      log.error('Error starting profiler', e)
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
        const prioritySampler = appsecStandalone.configure(config)
        this._tracer = new DatadogTracer(config, prioritySampler)
        this.dataStreamsCheckpointer = this._tracer.dataStreamsCheckpointer
        this.appsec = new AppsecSdk(this._tracer, config)
        this.llmobs = new LLMObsSDK(this._tracer, this._modules.llmobs, config)
        this._tracingInitialized = true
      }
      if (config.iast.enabled) {
        this._modules.iast.enable(config, this._tracer)
      }
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
