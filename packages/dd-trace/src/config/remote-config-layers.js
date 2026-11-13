'use strict'

const { getEnvironmentVariables } = require('./helper')

/**
 * @typedef {ReturnType<import('./index')>} Config
 * @typedef {'APM_TRACING' | 'APM_PROFILING'} Product
 * @typedef {Partial<Record<import('./helper').SupportedEnvKey, string>>} Settings
 */

/** @type {WeakMap<Config, Map<Product, Settings>>} */
const layersByConfig = new WeakMap()

/**
 * Replace a product's settings, preserving other products in last-update-wins order.
 *
 * @param {Config} config
 * @param {Product} product
 * @param {Settings | null} settings
 */
module.exports = function applyRemoteConfig (config, product, settings) {
  let layers = layersByConfig.get(config)
  if (layers === undefined) {
    layers = new Map()
    layersByConfig.set(config, layers)
  }

  layers.delete(product)
  if (settings !== null) {
    // Resolve aliases before merging so each setting has one key across products.
    layers.set(product, getEnvironmentVariables(settings, true))
  }

  if (layers.size === 1) {
    config.setRemoteConfig(layers.values().next().value)
    return
  }

  /** @type {Settings | null} */
  let merged = null
  for (const layer of layers.values()) {
    merged ??= {}
    Object.assign(merged, layer)
  }
  config.setRemoteConfig(merged)
}
