'use strict'

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
  layers[product] = settings

  const { APM_TRACING: tracing, APM_PROFILING: profiling } = layers
  if (tracing === null || profiling === null) {
    config.setRemoteConfig(tracing ?? profiling)
    return
  }
  // Resolve aliases first, so that each setting has a single key across products.
  config.setRemoteConfig({ ...getEnvironmentVariables(tracing, true), ...getEnvironmentVariables(profiling, true) })
}
