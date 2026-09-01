'use strict'

const { format } = require('node:url')

const { HttpsProxyAgent } = require('../../../../vendor/dist/https-proxy-agent')
const { getProxyForUrl } = require('../../../../vendor/dist/proxy-from-env')
const log = require('../log')

/**
 * @typedef {object} DirectEVPRoute
 * @property {URL} url - Direct intake URL
 * @property {string} basePath - Direct intake base path
 * @property {object} headers - Direct intake authentication headers
 * @property {import('node:https').Agent} [agent] - Optional HTTPS proxy agent
 */

/**
 * Creates an authenticated direct EVP intake route.
 *
 * This helper does not perform local receiver discovery.
 *
 * @param {import('../config/config-base')} config - Tracer configuration
 * @param {string} intake - EVP intake subdomain
 * @returns {DirectEVPRoute|undefined} Direct route when credentials and site are available
 */
function createDirectEVPRoute (config, intake) {
  const apiKey = config.DD_API_KEY
  if (!apiKey || !config.site) return

  try {
    const hostname = `${intake}.${config.site}`.toLowerCase()
    const url = new URL(format({
      protocol: 'https:',
      hostname,
    }))
    if (
      url.hostname !== hostname ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error('Invalid direct EVP intake URL')
    }

    const proxyUrl = getProxyForUrl(url.href)
    const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined

    const route = {
      url,
      basePath: '',
      headers: {
        'DD-API-KEY': apiKey,
      },
    }
    if (agent) route.agent = agent
    return route
  } catch (error) {
    log.debug('Unable to configure direct EVP intake: %s', error.message)
  }
}

module.exports = { createDirectEVPRoute }
