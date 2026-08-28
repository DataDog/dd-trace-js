'use strict'

/**
 * @param {ReturnType<import('../config')>} config - Debugger configuration
 * @param {string} path - Request path
 * @param {Record<string, string>} headers - Payload headers
 * @returns {{method: 'POST', url: string | URL, path: string, headers: Record<string, string>}}
 */
module.exports = function getRequestOptions (config, path, headers) {
  if (config.agentless) {
    headers['DD-API-KEY'] = config.apiKey
    headers['DD-EVP-ORIGIN'] = 'agent-debugger'
  }

  return {
    method: 'POST',
    url: config.url,
    path,
    headers,
  }
}
