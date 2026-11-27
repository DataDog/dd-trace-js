'use strict'

const { configurationsTable } = require('./defaults')
const { getEnvironmentVariables } = require('./helper')

/**
 * @typedef {ReturnType<import('./index')>} Config
 * @typedef {'APM_TRACING' | 'APM_PROFILING'} Product
 * @typedef {Partial<Record<import('./helper').SupportedEnvKey, string>>} Settings
 */

/** @type {WeakMap<Config, Record<Product, Settings | null>>} */
const layersByConfig = new WeakMap()

/**
 * Replace a product's settings and apply the settings of every active product. For a setting
 * both products supply, APM_PROFILING takes precedence over the broader APM_TRACING, whatever the
 * order of updates.
 *
 * @param {Config} config
 * @param {Product} product
 * @param {Settings | null} settings
 */
module.exports = function applyRemoteConfig (config, product, settings) {
  let layers = layersByConfig.get(config)
  if (layers === undefined) {
    layers = { APM_TRACING: null, APM_PROFILING: null }
    layersByConfig.set(config, layers)
  }
  const previousTracing = layers.APM_TRACING
  // Resolve aliases before comparing snapshots or combining products.
  layers[product] = settings === null ? null : getEnvironmentVariables(settings, true)

  const { APM_TRACING: tracing, APM_PROFILING: profiling } = layers
  if (tracing === null || (previousTracing === null && profiling === null)) {
    config.setRemoteConfig(tracing ?? profiling)
    return
  }

  const merged = { ...tracing }
  if (previousTracing !== null) {
    // Keep code settings that arrived after an unchanged tracing value.
    for (const name of Object.keys(tracing)) {
      if (tracing[name] !== previousTracing[name]) continue
      const path = configurationsTable[name].property ?? name
      if (config.getOrigin(path) === 'code') delete merged[name]
    }
  }
  config.setRemoteConfig(Object.assign(merged, profiling))
}
