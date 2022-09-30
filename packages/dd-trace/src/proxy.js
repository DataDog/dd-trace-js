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
const RemoteConfigManager = require('./remote_config')
const RemoteConfigCapabilities = require('./remote_config/capabilities')

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

      log.use(config.logger)
      log.toggle(config.debug, config.logLevel, this)

      const rc = new RemoteConfigManager(config, this)

      rc.start()

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
        } else if (config.appsec.enabled === undefined) { // only activate remote config when conf is not set locally
          rc.updateCapabilities(RemoteConfigCapabilities.ASM_ACTIVATION, true)

          // TODO: rename to ASM_FEATURES
          rc.on('ASM_FEATURES', (action, conf) => {
            if (typeof conf?.asm?.enabled === 'boolean') {
              if (action === 'apply' || action === 'modify') action = conf.asm.enabled // take control
              else action = config.appsec.enabled // give back control to local config

              if (action) {
                require('./appsec').enable(config)
              } else {
                require('./appsec').disable()
              }
            }
          })
        }

        if (config.iast.enabled) {
          require('./appsec/iast').enable(config)
        }

        this._tracer = new DatadogTracer(config)
        this._pluginManager.configure(config)
        setStartupLogPluginManager(this._pluginManager)
        telemetry.start(config, this._pluginManager)
      }

      if (config.isGitUploadEnabled) {
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
