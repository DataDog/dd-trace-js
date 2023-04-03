'use strict'
const NoopProxy = require('./noop/proxy')
const DatadogTracer = require('./tracer')
const Config = require('./config')
const metrics = require('./metrics')
const log = require('./log')
const { setStartupLogPluginManager } = require('./startup-log')
const telemetry = require('./telemetry')
const PluginManager = require('./plugin_manager')
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

    this._initialized = true

    try {
      const config = new Config(options) // TODO: support dynamic config

      startMiniAgent()

      if (config.remoteConfig.enabled && !config.isCiVisibility) {
        remoteConfig.enable(config)
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
        telemetry.start(config, this._pluginManager)
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

function  startMiniAgent () {
  console.log("cwd: " + process.cwd());
  try {
    const { spawn } = require('child_process');
    const { join } = require('path');

    const rust_binary_path = join(process.cwd(), 'datadog-serverless-trace-mini-agent');

    const mini_agent_process = spawn(rust_binary_path);

    mini_agent_process.stdout.on('data', (data) => {
      console.log(`stdout: ${data}`);
    });

    mini_agent_process.stderr.on('data', (data) => {
      console.error(`stderr: ${data}`);
    });

    mini_agent_process.on('close', (code) => {
      console.log(`child process exited with code ${code}`);
    });

    mini_agent_process.on('error', (err) => {
      console.log(`child process errored out: ${err}`);
    });
  } catch (e) {
    console.log("error spawning mini agent process: " + e);
  }
}

module.exports = Tracer
