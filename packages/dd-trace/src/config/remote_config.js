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

    // Filter to the allowlist here, at ingestion, so only a bounded (allowlist-sized) subset of
    // an otherwise untrusted, potentially very large sdk_config payload is ever retained in memory.
    const confPayload = conf.sdk_config
    let sdkConfig
    if (confPayload != null) {
      sdkConfig = {}
      for (const key of sdkConfigAllowlist) {
        // Env-style parsers (e.g. BOOLEAN, DECIMAL) assume a string and don't guard against
        // null/non-string input the way programmatic option coercion does, so drop it here
        // rather than let it reach setRemoteConfig and crash or silently miscoerce (e.g. Number(null) === 0).
        if (typeof confPayload[key] === 'string') sdkConfig[key] = confPayload[key]
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
