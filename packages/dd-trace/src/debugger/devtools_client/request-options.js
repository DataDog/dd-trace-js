'use strict'

/**
 * Build request options for the Agent proxy or the direct debugger intake.
 *
 * @param {object} config - Debugger configuration
 * @param {string} path - Request path
 * @param {Record<string, string>} headers - Payload headers
 * @returns {object} Request options
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
