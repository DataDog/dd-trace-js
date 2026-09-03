'use strict'

const RemoteConfigCapabilities = require('../remote_config/capabilities')
const log = require('../log')
const { sdkConfigAllowlist } = require('./sdk-config-allowlist')

module.exports = {
  enable,
}

/**
 * @typedef {ReturnType<import('../config')>} Config
 */

/**
 * Normalize sdk_config.config to a plain { KEY: value } object.
 *
 * The wire shape changed from an array of { key, value } entries to a flat object (dd-go#14029),
 * but stored configs aren't rewritten on deploy: a config saved before that change keeps
 * delivering the legacy array shape indefinitely, until it's next updated.
 *
 * @param {Array<{key: string, value: string}>|Record<string, string>} config
 * @returns {Record<string, string>}
 */
function normalizeSdkConfig (config) {
  if (Array.isArray(config)) {
    const out = {}
    for (const entry of config) {
      if (typeof entry?.key === 'string' && typeof entry.value === 'string') {
        out[entry.key] = entry.value
      }
    }
    return out
  }
  return config
}

/**
 * Manages multiple remote configurations with priority-based merging
 */
class RCClientManager {
  /**
   * @param {string} currentService - Current service name
   * @param {string} currentEnv - Current environment name
   */
  constructor (currentService, currentEnv) {
    this.configs = new Map() // config_id -> { priority, sdkConfig }
    this.currentService = currentService
    this.currentEnv = currentEnv
  }

  /**
   * Calculate priority based on target specificity. Higher values take precedence.
   * Priority order (highest → lowest):
   *   Service+Env (5) > Service (4) > Env (3) > Cluster (2) > Org (1)
   *
   * @param {object} conf - Remote config object with service_target and k8s_target_v2 properties
   * @returns {number} Priority value from 1 (org-level) to 5 (service+env specific)
   */
  calculatePriority (conf) {
    const serviceTarget = conf.service_target
    const k8sTarget = conf.k8s_target_v2

    if (serviceTarget) {
      const service = serviceTarget.service
      const env = serviceTarget.env

      const hasSpecificService = service && service !== '*'
      const hasSpecificEnv = env && env !== '*'

      if (hasSpecificService && hasSpecificEnv) return 5
      if (hasSpecificService) return 4
      if (hasSpecificEnv) return 3
    }

    if (k8sTarget) return 2

    return 1 // Org level
  }

  /**
   * Check if config matches current service/env
   *
   * @param {object} conf - Remote config object with service_target property
   * @returns {boolean} True if config matches current service/env or has no filter
   */
  matchesCurrentServiceEnv (conf) {
    const serviceTarget = conf.service_target
    if (!serviceTarget) return true // No filter means match all

    const service = serviceTarget.service
    const env = serviceTarget.env

    // Check service match
    if (service && service !== '*' && service !== this.currentService) {
      log.debug('[config/remote_config] Ignoring config for service: %s (current: %s)',
        service, this.currentService)
      return false
    }

    // Check env match
    if (env && env !== '*' && env !== this.currentEnv) {
      log.debug('[config/remote_config] Ignoring config for env: %s (current: %s)',
        env, this.currentEnv)
      return false
    }

    return true
  }

  /**
   * Add or update a config
   *
   * @param {string} configId - Unique identifier for the config
   * @param {object} conf - Remote config object to add
   */
  addConfig (configId, conf) {
    if (!this.matchesCurrentServiceEnv(conf)) {
      return
    }

    // sdk_config is delivered as { service_name, env, config: { KEY: value, ... } }; only the
    // allowlisted subset of config is ever retained.
    const rawEntries = conf.sdk_config?.config
    let sdkConfig
    if (rawEntries != null) {
      const entries = normalizeSdkConfig(rawEntries)
      sdkConfig = {}
      for (const key of Object.keys(entries)) {
        if (!sdkConfigAllowlist.has(key)) continue

        // The schema pins config values to strings (additionalProperties: {type: 'string'}), so a
        // non-string value can never reach this code from a real RC payload; drop it defensively only
        // for malformed entries rather than let it reach setRemoteConfig.
        const value = entries[key]
        if (typeof value === 'string') {
          sdkConfig[key] = value
        }
      }
    }

    const priority = this.calculatePriority(conf)
    this.configs.set(configId, { priority, sdkConfig })

    log.debug('[config/remote_config] Added config %s with priority %d', configId, priority)
  }

  /**
   * Remove a config
   *
   * @param {string} configId - Unique identifier for the config to remove
   */
  removeConfig (configId) {
    const removed = this.configs.delete(configId)
    if (removed) {
      log.debug('[config/remote_config] Removed config %s', configId)
    }
  }

  /**
   * Get merged config with higher priority configs overriding lower priority ones
   *
   * @returns {Partial<Record<import('./helper').SupportedEnvKey, string>>|null} Merged config object or
   *   null if no configs present
   */
  getMergedConfig () {
    if (this.configs.size === 0) return null

    let hasConfig = false

    const merged = [...this.configs.values()]
      .sort((a, b) => a.priority - b.priority)
      .reduce((merged, { sdkConfig }) => {
        if (sdkConfig == null) return merged
        hasConfig = true
        return Object.assign(merged, sdkConfig)
      }, {})

    return hasConfig ? merged : null
  }
}

/**
 * Configures remote config for core APM tracing functionality
 *
 * @param {import('../remote_config')} rc - RemoteConfig instance
 * @param {Config} config - Tracer config
 * @param {() => void} onConfigUpdated - Function to call when config is updated
 */
function enable (rc, config, onConfigUpdated) {
  // This tracer supports receiving multiple simultaneous targeted sdk_config payloads under the
  // APM_TRACING product (e.g. an org-level and a service-level config) and merges them by priority.
  rc.updateCapabilities(RemoteConfigCapabilities.APM_TRACING_MULTICONFIG, true)

  // This tracer supports receiving the full SDK_CONFIGURATION settings map, env-var-keyed.
  rc.updateCapabilities(RemoteConfigCapabilities.SDK_CONFIGURATION, true)

  const sdkConfigManager = new RCClientManager(config.service, config.env)

  // SDK_CONFIGURATION is delivered as a flat sdk_config map under the APM_TRACING product.
  rc.subscribeProducts('APM_TRACING')

  rc.setBatchHandler(['APM_TRACING'], (transaction) => {
    const { toUnapply, toApply, toModify } = transaction

    for (const item of toUnapply) {
      sdkConfigManager.removeConfig(item.id)
      transaction.ack(item.path)
    }

    for (const item of [...toApply, ...toModify]) {
      sdkConfigManager.addConfig(item.id, item.file)
      transaction.ack(item.path)
    }

    config.setRemoteConfig(sdkConfigManager.getMergedConfig())

    onConfigUpdated()
  })
}
