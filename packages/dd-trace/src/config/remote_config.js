'use strict'

const RemoteConfigCapabilities = require('../remote_config/capabilities')
const log = require('../log')
const applyRemoteConfig = require('./remote-config-layers')

// This tracer supports receiving multiple simultaneous targeted sdk_config payloads under the
// APM_TRACING product (e.g. an org-level and a service-level config) and merges them by priority.
const tracingCapabilities = RemoteConfigCapabilities.APM_TRACING_MULTICONFIG |
  // Keep advertising the legacy per-setting capabilities while the backend and UI still use them
  // to determine which settings are editable. Values are delivered through sdk_config below.
  RemoteConfigCapabilities.APM_TRACING_ENABLED |
  RemoteConfigCapabilities.APM_TRACING_SAMPLE_RATE |
  RemoteConfigCapabilities.APM_TRACING_SAMPLE_RULES |
  RemoteConfigCapabilities.APM_TRACING_CUSTOM_TAGS |
  RemoteConfigCapabilities.APM_TRACING_HTTP_HEADER_TAGS |
  RemoteConfigCapabilities.APM_TRACING_LOGS_INJECTION |
  RemoteConfigCapabilities.APM_TRACING_ENABLE_DYNAMIC_INSTRUMENTATION |
  RemoteConfigCapabilities.APM_TRACING_ENABLE_LIVE_DEBUGGING |
  RemoteConfigCapabilities.APM_TRACING_ENABLE_CODE_ORIGIN |
  // This tracer supports receiving the full SDK_CONFIGURATION settings map, env-var-keyed.
  RemoteConfigCapabilities.SDK_CONFIGURATION

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

    const sdkConfig = conf.sdk_config?.config

    const priority = this.calculatePriority(conf)
    const projected = { priority, sdkConfig }
    this.configs.set(configId, projected)

    log.debug('[config/remote_config] Added config %s with priority %d', configId, priority)
    return projected
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
  /** @param {ReturnType<RCClientManager['getMergedConfig']>} value */
  function applyValue (value) {
    applyRemoteConfig(config, 'APM_TRACING', value)
    onConfigUpdated()
  }

  if (rc.watchValues !== undefined) {
    const { service, env } = config
    let installedEmpty = false
    /** @type {Map<string, NonNullable<ReturnType<RCClientManager['addConfig']>>>} */
    let installedConfigs = new Map()
    /** @type {Set<string>} */
    let installedPaths = new Set()
    rc.watchValues({
      product: 'APM_TRACING',
      capabilities: tracingCapabilities,
      /** @param {import('../remote_config/wasm-client').WatchChanges} changes */
      project ({ upserts, removals }) {
        const manager = new RCClientManager(service, env)
        manager.configs = new Map(installedConfigs)
        const nextPaths = new Set(installedPaths)
        const decisions = /** @type {Map<string, import('../remote_config/wasm-client').WatchDecision>} */ (new Map())

        for (const { path, configId } of removals) {
          if (nextPaths.delete(path)) {
            manager.removeConfig(configId)
          }
        }

        /** @param {import('../remote_config/wasm-client').WatchUpsert} change */
        function upsert ({ path, configId, contents }) {
          try {
            const file = JSON.parse(contents)
            if (file === null || typeof file !== 'object' || Array.isArray(file)) {
              throw new Error('Expected a Remote Config APM object')
            }
            if (manager.addConfig(configId, file) === undefined) {
              decisions.set(path, 'ignored')
            }
            nextPaths.add(path)
          } catch (error) {
            decisions.set(path, error)
          }
        }

        const modifications = /** @type {import('../remote_config/wasm-client').WatchUpsert[]} */ ([])
        for (const change of upserts) {
          if (nextPaths.has(change.path)) {
            modifications.push(change)
          } else {
            upsert(change)
          }
        }
        for (const change of modifications) {
          upsert(change)
        }

        const value = manager.getMergedConfig()
        if (value === null && installedEmpty) {
          installedConfigs = manager.configs
          installedPaths = nextPaths
          return { decisions }
        }
        return {
          decisions,
          install () {
            // Applying a layer can change settings before throwing.
            installedEmpty = false
            applyValue(value)
            installedConfigs = manager.configs
            installedPaths = nextPaths
            installedEmpty = value === null
          },
        }
      },
    })
    return
  }

  rc.updateCapabilities(tracingCapabilities, true)
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

    applyValue(sdkConfigManager.getMergedConfig())
  })
}
