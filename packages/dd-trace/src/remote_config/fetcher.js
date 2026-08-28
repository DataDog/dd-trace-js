'use strict'

const { storage } = require('../../../datadog-core')

const legacyStorage = storage('legacy')

/**
 * The remote config client `RemoteConfig` drives. Both implementations satisfy the same contract,
 * so the change-record flow above them is identical either way:
 *
 * - `fetchChanges(callback)` reports the changes since the previous poll, removals first
 * - `setConfigState(path, applyState, applyError)` reports an apply outcome for a config
 * - `setExtraServices(services)` replaces the extra services reported to the agent
 * - `setProductCapabilities(products, capabilities)` replaces the subscription and returns the
 *   names it did not recognize
 *
 * @typedef {object} RcFetcher
 * @property {(callback: RcFetchCallback) => void} fetchChanges
 * @property {(path: string, applyState: number, applyError: string) => void} setConfigState
 * @property {(services: string[]) => void} setExtraServices
 * @property {(products: string[], capabilities: string[]) => string[]} setProductCapabilities
 */

/**
 * @callback RcFetchCallback
 * @param {Error|null} error
 * @param {RcChangeRecord[]} [changes]
 */

/**
 * @typedef {object} RcChangeRecord
 * @property {'add' | 'update' | 'remove'} kind
 * @property {string} path
 * @property {string} product
 * @property {string} configId
 * @property {string} name
 * @property {number} version
 * @property {string} [contents]
 */

/**
 * @typedef {object} RcFetcherOptions
 * @property {string} clientId
 * @property {string} runtimeId
 * @property {string} service
 * @property {string} env
 * @property {string} appVersion
 * @property {string[]} tags - Already-formatted `"key:value"` strings.
 * @property {string[]} processTags - Already-formatted `"key:value"` strings.
 * @property {string} language
 * @property {string} tracerVersion
 * @property {string} url - Agent or agentless Remote Config base URL.
 * @property {number} timeoutMs
 * @property {boolean} [agentless]
 * @property {string} [apiKey]
 * @property {string} [hostname]
 */

/**
 * @param {RcFetcherOptions} options
 * @returns {RcFetcher}
 */
function createFetcher (options) {
  if (!options.agentless) {
    const JsRemoteConfigFetcher = require('./js_fetcher')
    return new JsRemoteConfigFetcher(options)
  }

  return new LibdatadogRemoteConfigFetcher(options)
}

class LibdatadogRemoteConfigFetcher {
  #fetcher

  /**
   * @param {RcFetcherOptions} options
   */
  constructor ({ agentless, ...options }) {
    const { RemoteConfigFetcher } = require('@datadog/libdatadog')
    this.#fetcher = new RemoteConfigFetcher(options)
  }

  /**
   * @param {RcFetchCallback} callback
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
      changes => callback(null, changes),
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
   * @param {string[]} capabilities
   * @returns {string[]}
   */
  setProductCapabilities (products, capabilities) {
    return this.#fetcher.setProductCapabilities(products, capabilities)
  }
}

module.exports = createFetcher
