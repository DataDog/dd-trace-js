'use strict'

const integrations = require('./integrations')

class EventIntegrationManager {
  /**
   * @param {object} tracer Public tracer proxy.
   */
  constructor (tracer) {
    this._tracer = tracer
    this._config = undefined
    this._configsByName = {}
    this._integrationsByName = {}
  }

  /**
   * Configure every registered event integration after tracer initialization.
   *
   * @param {object} config Global tracer configuration.
   * @returns {void}
   */
  configure (config) {
    this._config = config
    for (const name of Object.keys(integrations)) this._load(name)
  }

  /**
   * Route tracer.use configuration to an event integration when registered.
   *
   * @param {string} name Integration name.
   * @param {boolean|object} config Integration configuration.
   * @returns {boolean} Whether an event integration owns this name.
   */
  configureIntegration (name, config) {
    if (!integrations[name]) return false

    const enabled = typeof config === 'boolean' ? config : config?.enabled !== false
    this._configsByName[name] = typeof config === 'boolean'
      ? { enabled: config }
      : { ...config, enabled }
    this._load(name)

    return true
  }

  /**
   * Disable all event integrations and release process-wide sources.
   *
   * @returns {void}
   */
  destroy () {
    for (const integration of Object.values(this._integrationsByName)) {
      integration.configure(this._config, { enabled: false })
    }
    this._integrationsByName = {}
  }

  _load (name) {
    if (!this._config) return

    const Integration = integrations[name]
    if (!Integration) return

    const integration = this._integrationsByName[name] ||=
      new Integration(this._tracer, this._config)
    const integrationConfig = this._configsByName[name] || {
      enabled: this._config.plugins !== false,
    }
    integration.configure(this._config, integrationConfig)
  }
}

module.exports = EventIntegrationManager
