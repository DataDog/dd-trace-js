'use strict'

const { storage } = require('../../../datadog-core')

const capabilities = require('./capabilities')

const legacyStorage = storage('legacy')
const capabilityEntries = Object.entries(capabilities)

class AgentlessRemoteConfigFetcher {
  #fetcher

  /**
   * @param {AgentlessRemoteConfigOptions} options
   */
  constructor (options) {
    const { RemoteConfigFetcher } = require('@datadog/libdatadog')
    this.#fetcher = new RemoteConfigFetcher(options)
  }

  /**
   * @param {(error?: Error, changes?: RemoteConfigChange[]) => void} callback
   */
  fetchChanges (callback) {
    let result

    try {
      result = legacyStorage.run({ noop: true }, () => this.#fetcher.fetchChanges())
    } catch (error) {
      callback(error)
      return
    }

    result.then(
      changes => callback(undefined, changes),
      error => callback(error)
    )
  }

  /**
   * @param {string} path
   * @param {number} applyState
   * @param {string} applyError
   */
  setConfigState (path, applyState, applyError) {
    this.#fetcher.setConfigState(path, applyState, applyError)
  }

  /**
   * @param {string[]} services
   */
  setExtraServices (services) {
    this.#fetcher.setExtraServices(services)
  }

  /**
   * @param {string[]} products
   * @param {string} encodedCapabilities
   * @returns {string[]}
   */
  setProductCapabilities (products, encodedCapabilities) {
    const hex = Buffer.from(encodedCapabilities, 'base64').toString('hex')
    const mask = BigInt(`0x${hex}`)
    const names = []

    for (const [name, capability] of capabilityEntries) {
      if ((mask & capability) !== 0n) names.push(name)
    }

    return this.#fetcher.setProductCapabilities(products, names)
  }
}

/**
 * @typedef {object} AgentlessRemoteConfigOptions
 * @property {string} clientId
 * @property {string} runtimeId
 * @property {string} service
 * @property {string} env
 * @property {string} appVersion
 * @property {string[]} tags
 * @property {string[]} processTags
 * @property {string} language
 * @property {string} tracerVersion
 * @property {string} url
 * @property {number} timeoutMs
 * @property {string} apiKey
 * @property {string} hostname
 */

/**
 * @typedef {object} RemoteConfigChange
 * @property {'add' | 'update' | 'remove'} kind
 * @property {string} path
 * @property {string} product
 * @property {string} configId
 * @property {number} version
 * @property {string} [contents]
 * @property {number} [length]
 * @property {Record<string, string>} [hashes]
 */

module.exports = AgentlessRemoteConfigFetcher
