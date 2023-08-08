'use strict'
const PluginManager = require('./plugin_manager')
const NoopProxy = require('./noop/proxy')
const DatadogTracer = require('./tracer')
const Config = require('./config')
const metrics = require('./metrics')
const log = require('./log')
const { setStartupLogPluginManager } = require('./startup-log')
const telemetry = require('./telemetry')
const remoteConfig = require('./appsec/remote_config')
const AppsecSdk = require('./appsec/sdk')

class Tracer extends NoopProxy {
  constructor () {
    super()

    this._initialized = false
    this._pluginManager = new PluginManager(this)
  }

  init (options) {
    if (this._initialized) return this

    process.emitWarning('The dd-trace@v2.x release line reached end of life on ' +
      '2023-08-15 and will no longer receive updates. Please upgrade.')

    this._initialized = true

    try {
      const config = new Config(options) // TODO: support dynamic code config

      if (config.remoteConfig.enabled && !config.isCiVisibility) {
        const rc = remoteConfig.enable(config)

        rc.on('APM_TRACING', (action, conf) => {
          if (action === 'unapply') {
            config.configure({}, true)
          } else {
            config.configure(conf.lib_config, true)
          }

          if (config.tracing) {
            this._tracer.configure(config)
            this._pluginManager.configure(config)
          }
        })
      }

      if (config.isGCPFunction || config.isAzureFunctionConsumptionPlan) {
        require('./serverless').maybeStartServerlessMiniAgent(config)
      }

      if (config.profiling.enabled) {
        // do not stop tracer initialization if the profiler fails to be imported
        try {
          const profiler = require('./profiler')
          profiler.start(config)
        } catch (e) {
          log.error(e)
        }
      }

      if (config.runtimeMetrics) {
        metrics.start(config)
      }

      if (config.tracing) {
        // TODO: This should probably not require tracing to be enabled.
        telemetry.start(config, this._pluginManager)

        // dirty require for now so zero appsec code is executed unless explicitly enabled
        if (config.appsec.enabled) {
          require('./appsec').enable(config)
        }

        this._tracer = new DatadogTracer(config)
        this.appsec = new AppsecSdk(this._tracer, config)

        if (config.iast.enabled) {
          require('./appsec/iast').enable(config, this._tracer)
        }

        this._pluginManager.configure(config)
        setStartupLogPluginManager(this._pluginManager)

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

  use () {
    this._pluginManager.configurePlugin(...arguments)
    return this
  }

  get TracerProvider () {
    return require('./opentelemetry/tracer_provider')
  }
}

module.exports = Tracer
