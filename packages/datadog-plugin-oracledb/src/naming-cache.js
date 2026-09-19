'use strict'

/**
 * @typedef {{
 *   operationName: string,
 *   service: { name: string, source: string | undefined }
 * }} Naming
 */

class NamingCache {
  /** @type {boolean} */
  #dynamic = false
  /** @type {import('../../dd-trace/src/plugins/tracing')} */
  #plugin
  /** @type {string | undefined} */
  #operation
  /** @type {string | undefined} */
  #operationName
  /** @type {object | undefined} */
  #nomenclatureConfig
  /** @type {Naming | undefined} */
  #naming
  /** @type {WeakMap<object, Naming> | undefined} */
  #namings
  /** @type {string | undefined} */
  #primitiveParams
  /** @type {Naming | undefined} */
  #primitiveNaming

  /**
   * @param {import('../../dd-trace/src/plugins/tracing')} plugin
   * @param {string} [operation]
   */
  constructor (plugin, operation) {
    this.#plugin = plugin
    this.#operation = operation
  }

  configure () {
    this.#dynamic = typeof this.#plugin.config.service === 'function'
    this.#nomenclatureConfig = undefined
    this.#naming = undefined
    this.#namings = undefined
    this.#operationName = undefined
    this.#primitiveNaming = undefined
  }

  /**
   * @param {object | string | undefined} params
   * @returns {Naming}
   */
  get (params) {
    const nomenclatureConfig = this.#plugin._tracer._nomenclature.config
    if (this.#nomenclatureConfig !== nomenclatureConfig) {
      this.#nomenclatureConfig = nomenclatureConfig
      this.#naming = undefined
      this.#namings = undefined
      this.#operationName = undefined
      this.#primitiveNaming = undefined
    }

    if (!this.#dynamic) {
      this.#naming ??= this.#create(params)
      return this.#naming
    }

    if (typeof params !== 'object') {
      if (this.#primitiveNaming === undefined || this.#primitiveParams !== params) {
        this.#primitiveParams = params
        this.#primitiveNaming = this.#create(params)
      }
      return this.#primitiveNaming
    }

    this.#namings ??= new WeakMap()
    let naming = this.#namings.get(params)
    if (naming === undefined) {
      naming = this.#create(params)
      this.#namings.set(params, naming)
    }
    return naming
  }

  /**
   * @param {object | string | undefined} params
   * @returns {Naming}
   */
  #create (params) {
    this.#operationName ??= this.#operation === undefined
      ? this.#plugin.operationName()
      : this.#plugin.operationName({ operation: this.#operation })
    const service = this.#plugin.serviceName({ pluginConfig: this.#plugin.config, params })

    return { operationName: this.#operationName, service }
  }
}

module.exports = NamingCache
