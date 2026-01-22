'use strict'

const os = require('os')
const fs = require('fs')
const { getEnvironmentVariable } = require('./helper')

class StableConfig {
  constructor () {
    this.warnings = [] // Logger hasn't been initialized yet, so we can't use log.warn
    this.localEntries = {}
    this.fleetEntries = {}
    this.wasm_loaded = false

    const { localConfigPath, fleetConfigPath } = this.#getStableConfigPaths()

    const localConfig = this.#readConfigFromPath(localConfigPath)
    const fleetConfig = this.#readConfigFromPath(fleetConfigPath)
    if (!localConfig && !fleetConfig) {
      // Bail out early if files are empty or we can't read them to avoid unnecessary library loading
      return
    }

    // Note: we don't enforce loading because there may be cases where the library is not available and we
    // want to avoid breaking the application. In those cases, we will not have the file-based configuration.
    let libdatadog
    try {
      libdatadog = require('@datadog/libdatadog')
      this.wasm_loaded = true
    } catch {
      this.warnings.push('Can\'t load libdatadog library')
      return
    }

    const libconfig = libdatadog.maybeLoad('library_config')
    if (libconfig === undefined) {
      this.warnings.push('Can\'t load library_config library')
      return
    }

    try {
      const configurator = new libconfig.JsConfigurator()
      // Intentionally pass through the raw environment variables for reporting.
      // eslint-disable-next-line eslint-rules/eslint-process-env
      configurator.set_envp(Object.entries(process.env).map(([key, value]) => `${key}=${value}`))
      configurator.set_args(process.argv)
      configurator.get_configuration(localConfig, fleetConfig).forEach((entry) => {
        if (entry.source === 'local_stable_config') {
          this.localEntries[entry.name] = entry.value
        } else if (entry.source === 'fleet_stable_config') {
          this.fleetEntries[entry.name] = entry.value
        }
      })
    } catch (e) {
      this.warnings.push(`Error parsing configuration from file: ${e.message}`)
    }
  }

  #readConfigFromPath (path) {
    try {
      return fs.readFileSync(path, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.warnings.push(`Error reading config file at ${path}. ${err.code}: ${err.message}`)
      }
      return '' // Always return a string for configurator.get_configuration()
    }
  }

  #getStableConfigPaths () {
    // TODO(BridgeAR): Remove these environment variables once we have a proper way to test the stable config.
    // Allow overriding the paths for testing
    let localConfigPath = getEnvironmentVariable('DD_TEST_LOCAL_CONFIG_PATH')
    let fleetConfigPath = getEnvironmentVariable('DD_TEST_FLEET_CONFIG_PATH')
    switch (os.platform()) {
      case 'darwin':
        localConfigPath ??= '/opt/datadog-agent/etc/application_monitoring.yaml'
        fleetConfigPath ??= '/opt/datadog-agent/etc/managed/datadog-agent/stable/application_monitoring.yaml'
        break
      case 'win32':
        localConfigPath ??= String.raw`C:\ProgramData\Datadog\application_monitoring.yaml`
        fleetConfigPath ??= String.raw`C:\ProgramData\Datadog\managed\datadog-agent\stable\application_monitoring.yaml`
        break
      default:
        // Linux and other platforms as fallback
        localConfigPath ??= '/etc/datadog-agent/application_monitoring.yaml'
        fleetConfigPath ??= '/etc/datadog-agent/managed/datadog-agent/stable/application_monitoring.yaml'
    }

    return { localConfigPath, fleetConfigPath }
  }
}

module.exports = StableConfig
