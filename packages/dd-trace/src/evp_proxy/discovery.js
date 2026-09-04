'use strict'

const { fetchAgentInfo } = require('../agent/info')
const log = require('../log')

const TRAILING_SLASHES = /\/+$/

/**
 * Receiver discovery contract
 *
 * The tracer sends `GET /info` to its configured local Agent URL. An
 * Agent-compatible trace receiver produces the response. The tracer does not.
 *
 * The full Agent and serverless-init embed the same trace receiver. A future
 * in-process receiver can expose the same contract. Callers can therefore
 * select capabilities without detecting the receiver implementation.
 *
 * For EVP discovery, `endpoints` advertises registered proxy paths.
 * `evp_proxy_allowed_headers` advertises headers that the proxy forwards to
 * intake. It does not include routing headers that the proxy consumes, such as
 * `X-Datadog-EVP-Subdomain`.
 *
 * An advertised route is not a health check. The receiver can register an EVP
 * route while configuration disables its handler. The request then returns
 * `405`. The `/info` version also identifies the embedded Agent code, not a
 * serverless-init image or deployment type.
 *
 * This module only discovers a candidate route. A missing or unresponsive
 * `/info` endpoint returns an error through the shared request timeout and
 * retry policy. A valid response without a compatible path returns no route.
 * Discovery sends no events, so the caller can safely select direct intake
 * after either result. The caller also owns later delivery failures. Exposure
 * delivery replays a batch through direct intake after a definitive local
 * rejection. After an ambiguous local failure, it switches future batches to
 * direct intake without replaying the failed batch.
 *
 * Reference implementations:
 *
 * Agent `/info` and EVP proxy:
 * https://github.com/DataDog/datadog-agent/tree/main/pkg/trace/api
 *
 * serverless-init entry point and embedded trace receiver:
 * https://github.com/DataDog/datadog-agent/blob/main/cmd/serverless-init/main.go
 * https://github.com/DataDog/datadog-agent/blob/main/pkg/serverless/trace/trace.go
 */

/**
 * Selects the first advertised EVP proxy path that the caller supports.
 *
 * @param {object} agentInfo - Agent `/info` response
 * @param {object} options - Selection options
 * @param {string[]} options.supportedPaths - Supported paths in preference order
 * @param {string[]} [options.requiredHeaders] - Headers that the proxy must forward unchanged to intake. Each
 * header must appear in `evp_proxy_allowed_headers`. Do not include routing headers that the Agent consumes.
 * @returns {string|undefined} Selected normalized path
 */
function selectEVPProxyPath (agentInfo, { supportedPaths, requiredHeaders = [] } = {}) {
  if (!Array.isArray(agentInfo?.endpoints) ||
      !Array.isArray(supportedPaths) ||
      !Array.isArray(requiredHeaders) ||
      requiredHeaders.some(header => typeof header !== 'string')) {
    return
  }

  const allowedHeaders = agentInfo.evp_proxy_allowed_headers
  if (allowedHeaders !== undefined) {
    if (!Array.isArray(allowedHeaders)) return

    const normalizedHeaders = new Set()
    for (const header of allowedHeaders) {
      if (typeof header === 'string') {
        normalizedHeaders.add(header.toLowerCase())
      }
    }

    if (requiredHeaders.some(header => !normalizedHeaders.has(header.toLowerCase()))) {
      return
    }
  }

  const advertisedPaths = new Set()
  for (const endpoint of agentInfo.endpoints) {
    if (typeof endpoint === 'string') {
      advertisedPaths.add(endpoint.replace(TRAILING_SLASHES, ''))
    }
  }

  for (const supportedPath of supportedPaths) {
    if (typeof supportedPath !== 'string') continue

    const normalizedPath = supportedPath.replace(TRAILING_SLASHES, '')
    if (advertisedPaths.has(normalizedPath)) {
      return normalizedPath
    }
  }
}

/**
 * Discovers an EVP proxy route through the configured Agent URL.
 *
 * This function performs discovery only when the caller invokes it. It stores
 * no state. The Agent information client owns its existing response cache.
 *
 * @param {URL} url - Configured Agent URL
 * @param {object} options - Selection options
 * @param {string[]} options.supportedPaths - Supported paths in preference order
 * @param {string[]} [options.requiredHeaders] - Headers that the proxy must forward unchanged to intake. Each
 * header must appear in `evp_proxy_allowed_headers`. Do not include routing headers that the Agent consumes.
 * @param {boolean} [options.retry] - Whether the Agent information request retries connection failures
 * @param {(error: Error|null, route?: {url: URL, basePath: string}) => void} callback - Result callback
 * @returns {void}
 */
function discoverEVPProxy (url, options, callback) {
  const handleAgentInfo = (error, agentInfo) => {
    if (error) {
      callback(error)
      return
    }

    const basePath = selectEVPProxyPath(agentInfo, options)
    if (basePath === undefined) {
      callback(null)
      return
    }

    log.debug('EVP proxy route %s discovered through the configured local receiver', basePath)
    callback(null, { url, basePath })
  }

  if (options.retry === undefined) {
    fetchAgentInfo(url, handleAgentInfo)
    return
  }

  fetchAgentInfo(url, handleAgentInfo, { retry: options.retry })
}

module.exports = {
  discoverEVPProxy,
  selectEVPProxyPath,
}
