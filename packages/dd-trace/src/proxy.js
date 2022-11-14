'use strict'
const { channel } = require('diagnostics_channel')

const NoopProxy = require('./noop/proxy')
const DatadogTracer = require('./tracer')
const Config = require('./config')
const metrics = require('./metrics')
const log = require('./log')
const { setStartupLogPluginManager } = require('./startup-log')
const telemetry = require('./telemetry')
const PluginManager = require('./plugin_manager')
const { sendGitMetadata } = require('./ci-visibility/exporters/git/git_metadata')

const gitMetadataUploadFinishCh = channel('ci:git-metadata-upload:finish')

class Tracer extends NoopProxy {
  constructor () {
    super()

    this._initialized = false
    this._pluginManager = new PluginManager(this)
  }

  init (options) {
    if (this._initialized) return this

    this._initialized = true

    try {
      const config = new Config(options) // TODO: support dynamic config

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
        // dirty require for now so zero appsec code is executed unless explicitly enabled
        if (config.appsec.enabled) {
          require('./appsec').enable(config)
        }
        if (config.iast.enabled) {
          require('./appsec/iast').enable(config)
        }

        this._tracer = new DatadogTracer(config)
        this._pluginManager.configure(config)
        setStartupLogPluginManager(this._pluginManager)
        telemetry.start(config, this._pluginManager)
      }

      if (config.isGitUploadEnabled || config.isIntelligentTestRunnerEnabled) {
        sendGitMetadata(config.site, (err) => {
          if (err) {
            log.error(`Error uploading git metadata: ${err}`)
          } else {
            log.debug('Successfully uploaded git metadata')
          }
          gitMetadataUploadFinishCh.publish(err)
        })
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
}

module.exports = Tracer
