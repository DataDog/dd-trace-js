'use strict'

const os = require('os')
const fs = require('fs')
const log = require('../log')
const { getEnvironmentVariable } = require('./helper')

class StableConfig {
  constructor () {
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
      log.warn('Can\'t load libdatadog library')
      return
    }

    const libconfig = libdatadog.maybeLoad('library_config')
    if (libconfig === undefined) {
      log.warn('Can\'t load library_config library')
      return
    }

    try {
      const configurator = new libconfig.JsConfigurator()
      // Intentionally pass through the raw environment variables for reporting.
      // eslint-disable-next-line eslint-rules/eslint-process-env
      configurator.set_envp(Object.entries(process.env).map(([key, value]) => `${key}=${value}`))
      configurator.set_args(process.argv)
      for (const entry of configurator.get_configuration(localConfig, fleetConfig)) {
        if (entry.source === 'local_stable_config') {
          this.localEntries[entry.name] = entry.value
        } else if (entry.source === 'fleet_stable_config') {
          this.fleetEntries[entry.name] = entry.value
        }
      }
    } catch (error) {
      log.warn('Error parsing configuration from file: %s', error.message)
    }
  }

  #readConfigFromPath (path) {
    try {
      return fs.readFileSync(path, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') {
        log.warn('Error reading config file at %s. %s: %s', path, error.code, error.message)
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
