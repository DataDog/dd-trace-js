'use strict'

const RemoteConfigCapabilities = require('../remote_config/capabilities')
const log = require('../log')

module.exports = {
  enable
}

/**
 * @typedef {object} RemoteConfigOptions
 * @property {boolean} [dynamic_instrumentation_enabled] - Enable Dynamic Instrumentation
 * @property {boolean} [code_origin_enabled] - Enable code origin tagging for spans
 * @property {Array<{header: string, tag_name?: string}>} [tracing_header_tags] - HTTP headers to tag
 * @property {Array<string>} [tracing_tags] - Global tags (format: "key:value")
 * @property {number} [tracing_sampling_rate] - Global sampling rate (0.0-1.0)
 * @property {boolean} [log_injection_enabled] - Enable trace context log injection
 * @property {boolean} [tracing_enabled] - Enable/disable tracing globally
 * @property {Array<object>} [tracing_sampling_rules] - Trace sampling rules configuration
 */

/**
 * @typedef {ReturnType<import('../config')>} Config
 */

/**
 * Manages multiple APM_TRACING configurations with priority-based merging
 */
class RCClientLibConfigManager {
  /**
   * @param {string} currentService - Current service name
   * @param {string} currentEnv - Current environment name
   */
  constructor (currentService, currentEnv) {
    this.configs = new Map() // config_id -> { conf, priority }
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

    const priority = this.calculatePriority(conf)
    this.configs.set(configId, { conf, priority })

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
   * Get merged lib_config by taking first non-null value for each field
   * Configs are sorted by priority (highest first)
   *
   * @returns {RemoteConfigOptions|null} Merged config object or null if no configs present
   */
  getMergedLibConfig () {
    if (this.configs.size === 0) {
      // When no configs are present, return null to signal config.js to reset all RC fields
      return null
    }

    // Sort configs by priority (highest first)
    const sortedConfigs = [...this.configs.values()]
      .sort((a, b) => b.priority - a.priority)

    const merged = {}
    let libConfigCount = 0

    // Merge configs: take first non-null/undefined value for each field
    // If a field is explicitly set to null, that means "reset to default"
    for (const { conf } of sortedConfigs) {
      const libConfig = conf.lib_config
      if (libConfig == null) continue
      libConfigCount++

      for (const [key, value] of Object.entries(libConfig)) {
        if (key in merged) continue

        // Set the value even if it's null (to reset) but not if it's undefined (missing)
        if (value === null) {
          merged[key] = undefined // TODO: Should this be null?
        } else if (value !== undefined) {
          merged[key] = value
        }
      }
    }

    if (libConfigCount === 0) {
      // When no configs are present, return null to signal config.js to reset all RC fields
      return null
    }

    log.debug('[config/remote_config] Merged %d configs into lib_config', libConfigCount)
    return merged
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
  // This tracer supports receiving config subsets via the APM_TRACING product handler.
  rc.updateCapabilities(RemoteConfigCapabilities.APM_TRACING_MULTICONFIG, true)

  // Tracing
  rc.updateCapabilities(RemoteConfigCapabilities.APM_TRACING_ENABLED, true)
  rc.updateCapabilities(RemoteConfigCapabilities.APM_TRACING_SAMPLE_RATE, true)
  rc.updateCapabilities(RemoteConfigCapabilities.APM_TRACING_SAMPLE_RULES, true)
  rc.updateCapabilities(RemoteConfigCapabilities.APM_TRACING_CUSTOM_TAGS, true)
  rc.updateCapabilities(RemoteConfigCapabilities.APM_TRACING_HTTP_HEADER_TAGS, true)

  // Log Management
  rc.updateCapabilities(RemoteConfigCapabilities.APM_TRACING_LOGS_INJECTION, true)

  // Debugger
  rc.updateCapabilities(RemoteConfigCapabilities.APM_TRACING_ENABLE_DYNAMIC_INSTRUMENTATION, true)

  // Code Origin
  rc.updateCapabilities(RemoteConfigCapabilities.APM_TRACING_ENABLE_CODE_ORIGIN, true)

  const rcClientLibConfigManager = new RCClientLibConfigManager(config.service, config.env)

  // Use a batch handler to process all changes before updating the config. This is important in case there's
  // conflicting configs between, for example, the org and service level.
  rc.setBatchHandler(['APM_TRACING'], (transaction) => {
    const { toUnapply, toApply, toModify } = transaction

    for (const item of toUnapply) {
      rcClientLibConfigManager.removeConfig(item.id)
      transaction.ack(item.path)
    }

    for (const item of [...toApply, ...toModify]) {
      rcClientLibConfigManager.addConfig(item.id, item.file)
      transaction.ack(item.path)
    }

    // Get merged config and apply it
    const mergedLibConfig = rcClientLibConfigManager.getMergedLibConfig()
    config.setRemoteConfig(mergedLibConfig)

    onConfigUpdated()
  })
}
