'use strict'

const { storage } = require('../../../datadog-core')
const log = require('../log')

/**
 * The remote config client `RemoteConfig` drives. Both implementations satisfy the same contract,
 * so the change-record flow above them is identical either way:
 *
 * - `fetchChanges()` resolves to the changes since the previous poll, removals first, or rejects
 * - `setConfigState(path, applyState, applyError)` reports an apply outcome for a config
 * - `setExtraServices(services)` replaces the extra services reported to the agent
 * - `setProductCapabilities(products, capabilities)` replaces the subscription and returns the
 *   names it did not recognize
 *
 * @typedef {object} RcFetcher
 * @property {() => Promise<RcChangeRecord[]>} fetchChanges
 * @property {(path: string, applyState: number, applyError: string) => void} setConfigState
 * @property {(services: string[]) => void} setExtraServices
 * @property {(products: string[], capabilities: string[]) => string[]} setProductCapabilities
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
 * @property {string} url - Agent base URL.
 * @property {number} timeoutMs
 */

/**
 * Builds the remote config client: libdatadog's, or the JS one where that is unavailable.
 *
 * libdatadog's client is WebAssembly, so it runs wherever the tracer does. The JS fallback only
 * covers installs that omit the optional `@datadog/libdatadog` dependency altogether (AWS Lambda
 * layers do) or runtimes without WebAssembly.
 *
 * @param {RcFetcherOptions} options
 * @returns {RcFetcher}
 */
function createFetcher (options) {
  try {
    const remoteConfig = require('@datadog/libdatadog').load('remote_config')

    // Hand the module a hook that runs its HTTP in a noop async context, so the poll it issues is
    // not re-instrumented by our own http plugin. The same hook the native spans pipeline installs,
    // and what the JS client gets for free from `exporters/common/request`.
    const legacyStorage = storage('legacy')
    remoteConfig.setStorage(legacyStorage.run.bind(legacyStorage, { noop: true }))

    return new remoteConfig.RemoteConfigFetcher(options)
  } catch (err) {
    log.debug('[RC] Falling back to the JS remote config client', err)

    const JsRemoteConfigFetcher = require('./js_fetcher')

    return new JsRemoteConfigFetcher(options)
  }
}

module.exports = createFetcher
