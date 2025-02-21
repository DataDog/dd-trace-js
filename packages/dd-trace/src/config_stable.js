const os = require('os')
const fs = require('fs')
const { isTrue, isFalse, normalizeProfilingEnabledValue } = require('./util')

class StableConfig {
  constructor () {
    Object.assign(this, this.getStableConfig())
  }

  FLEET_STABLE_CONFIG_ORIGIN = 'fleet_stable_config'
  LOCAL_STABLE_CONFIG_ORIGIN = 'local_stable_config'

  _getStableConfigPaths () {
    let localConfigPath = ''
    let fleetConfigPath = ''
    switch (os.type().toLowerCase()) {
      case 'linux':
        localConfigPath = '/etc/datadog-agent/application_monitoring.yaml'
        fleetConfigPath = '/etc/datadog-agent/managed/datadog-agent/stable/application_monitoring.yaml'
        break
      case 'darwin':
        localConfigPath = '/opt/datadog-agent/etc/application_monitoring.yaml'
        fleetConfigPath = '/opt/datadog-agent/etc/managed/datadog-agent/stable/application_monitoring.yaml'
        break
      case 'win32':
        localConfigPath = 'C:\\ProgramData\\Datadog\\application_monitoring.yaml'
        fleetConfigPath = 'C:\\ProgramData\\Datadog\\managed\\datadog-agent\\stable\\application_monitoring.yaml'
        break
      default:
        break
    }

    // Allow overriding the paths for testing
    if (process.env.DD_TEST_LOCAL_CONFIG_PATH !== undefined) {
      localConfigPath = process.env.DD_TEST_LOCAL_CONFIG_PATH
    }
    if (process.env.DD_TEST_FLEET_CONFIG_PATH !== undefined) {
      fleetConfigPath = process.env.DD_TEST_FLEET_CONFIG_PATH
    }

    return { localConfigPath, fleetConfigPath }
  }

  getStableConfig () {
    // Note: we use maybeLoad because there may be cases where the library is not available and we
    // want to avoid breaking the application. In those cases, we will not have the file-based configuration.
    const warnings = [] // Logger hasn't been initialized yet, so we can't use log.warn
    const localEntries = {}
    const fleetEntries = {}

    const { localConfigPath, fleetConfigPath } = this._getStableConfigPaths()
    if (!fs.existsSync(localConfigPath) && !fs.existsSync(fleetConfigPath)) {
      // Check if files exist, if not bail out early to avoid unnecessary library loading
      return { localEntries, fleetEntries, warnings }
    }

    // libdatadog isn't always available (e.g serverless) so we need to handle that case gracefully
    let libdatadog
    try {
      libdatadog = require('@datadog/libdatadog')
    } catch (e) {
      warnings.push('Can\'t load libdatadog library')
      return { localEntries, fleetEntries, warnings }
    }

    const libconfig = libdatadog.maybeLoad('library_config')
    if (libconfig !== undefined) {
      const configurator = new libconfig.JsConfigurator()
      let localConfig = ''
      try {
        localConfig = fs.readFileSync(localConfigPath, 'utf8')
      } catch (err) {
        if (err.code !== 'ENOENT') {
          warnings.push(`Error reading local config file: ${localConfigPath}`)
        }
      }
      let fleetConfig = ''
      try {
        fleetConfig = fs.readFileSync(fleetConfigPath, 'utf8')
      } catch (err) {
        if (err.code !== 'ENOENT') {
          warnings.push(`Error reading fleet config file: ${fleetConfigPath}`)
        }
      }

      if (localConfig || fleetConfig) {
        configurator.set_envp(Object.entries(process.env).map(([key, value]) => `${key}=${value}`))
        configurator.set_args(process.argv)
        configurator.get_configuration(localConfig.toString(), fleetConfig.toString()).forEach((entry) => {
          if (entry.source === 'local_stable_config') {
            localEntries[entry.name] = entry.value
          } else if (entry.source === 'fleet_stable_config') {
            fleetEntries[entry.name] = entry.value
          }
        })
      }
    }
    return { localEntries, fleetEntries, warnings }
  }

  applyLocalConfig (obj) {
    this._applyConfig(this.localEntries, obj)
  }

  applyFleetConfig (obj) {
    this._applyConfig(this.fleetEntries, obj)
  }

  _applyConfig (config, obj) {
    const {
      DD_APPSEC_ENABLED,
      DD_APPSEC_SCA_ENABLED,
      DD_DATA_STREAMS_ENABLED,
      DD_DYNAMIC_INSTRUMENTATION_ENABLED,
      DD_ENV,
      DD_IAST_ENABLED,
      DD_LOGS_INJECTION,
      DD_PROFILING_ENABLED,
      DD_RUNTIME_METRICS_ENABLED,
      DD_SERVICE,
      DD_VERSION
    } = config

    this._setBoolean(obj, 'appsec.enabled', DD_APPSEC_ENABLED)
    this._setBoolean(obj, 'appsec.sca.enabled', DD_APPSEC_SCA_ENABLED)
    this._setBoolean(obj, 'dsmEnabled', DD_DATA_STREAMS_ENABLED)
    this._setBoolean(obj, 'dynamicInstrumentation.enabled', DD_DYNAMIC_INSTRUMENTATION_ENABLED)
    this._setString(obj, 'env', DD_ENV)
    this._setBoolean(obj, 'iast.enabled', DD_IAST_ENABLED)
    this._setBoolean(obj, 'logInjection', DD_LOGS_INJECTION)
    const profilingEnabledEnv = DD_PROFILING_ENABLED
    const profilingEnabled = normalizeProfilingEnabledValue(profilingEnabledEnv)
    this._setString(obj, 'profiling.enabled', profilingEnabled)
    this._setBoolean(obj, 'runtimeMetrics', DD_RUNTIME_METRICS_ENABLED)
    this._setString(obj, 'service', DD_SERVICE)
    this._setString(obj, 'version', DD_VERSION)
  }

  _setBoolean (obj, name, value) {
    if (value === undefined || value === null) {
      this._setValue(obj, name, value)
    } else if (isTrue(value)) {
      this._setValue(obj, name, true)
    } else if (isFalse(value)) {
      this._setValue(obj, name, false)
    }
  }

  _setString (obj, name, value) {
    obj[name] = value ? String(value) : undefined // unset for empty strings
  }

  _setValue (obj, name, value) {
    obj[name] = value
  }
}

module.exports = StableConfig
