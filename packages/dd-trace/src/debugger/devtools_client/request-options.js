'use strict'

const { getHttpsProxyAgent } = require('../../evp_proxy/direct')

/**
 * @param {ReturnType<import('../config')>} config - Debugger configuration
 * @param {string} path - Request path
 * @param {Record<string, string>} headers - Payload headers
 * @returns {{
 *   method: 'POST',
 *   url: string | URL,
 *   path: string,
 *   headers: Record<string, string>,
 *   agent?: import('node:https').Agent
 * }}
 */
module.exports = function getRequestOptions (config, path, headers) {
  const options = {
    method: 'POST',
    url: config.url,
    path,
    headers,
  }

  if (config.agentless) {
    if (config.apiKey !== undefined) headers['DD-API-KEY'] = config.apiKey
    headers['DD-EVP-ORIGIN'] = 'agent-debugger'
    const agent = getHttpsProxyAgent(config.url.href)
    if (agent !== undefined) options.agent = agent
  }

  return options
}
