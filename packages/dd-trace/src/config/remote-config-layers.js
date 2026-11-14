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
 * Replace a product's settings, preserving other products in last-update-wins order.
 *
 * @param {Config} config
 * @param {Product} product
 * @param {Settings | null} settings
 */
module.exports = function applyRemoteConfig (config, product, settings) {
  const layers = layersByConfig.get(config)
  if (layers === undefined) {
    if (settings !== null) {
      layersByConfig.set(config, { APM_TRACING: null, APM_PROFILING: null, [product]: settings })
    }
    config.setRemoteConfig(settings)
    return
  }

  const previous = layers[product]
  const otherProduct = product === 'APM_TRACING' ? 'APM_PROFILING' : 'APM_TRACING'
  const other = layers[otherProduct]
  layers[product] = settings

  if (settings !== null && other !== null) {
    // Normalize both layers on their first overlap, then reuse the other layer's canonical keys.
    const base = previous === null ? getEnvironmentVariables(other, true) : other
    layers[otherProduct] = base
    layers[product] = getEnvironmentVariables(settings, true)
    settings = { ...base, ...layers[product] }
  }
  config.setRemoteConfig(settings ?? other)
}
