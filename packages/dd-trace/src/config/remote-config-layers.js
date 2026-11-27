'use strict'

const { getEnvironmentVariables } = require('./helper')

/**
 * @typedef {ReturnType<import('./index')>} Config
 * @typedef {'APM_TRACING' | 'APM_PROFILING'} Product
 * @typedef {import('./helper').SupportedEnvKey} SupportedEnvKey
 * @typedef {Partial<Record<SupportedEnvKey, string>>} Settings
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
  const previous = layers[product]
  layers[product] = settings

  const { APM_TRACING: tracing, APM_PROFILING: profiling } = layers
  // Resolve aliases first, so that each setting has a single key across products.
  const merged = tracing === null || profiling === null
    ? tracing ?? profiling
    : { ...getEnvironmentVariables(tracing, true), ...getEnvironmentVariables(profiling, true) }
  if (product === 'APM_PROFILING') {
    const profilingKeys = /** @type {SupportedEnvKey[]} */ (Object.keys({ ...previous, ...settings }))
    config.setRemoteConfig(merged, profilingKeys)
  } else {
    config.setRemoteConfig(merged)
  }
}
