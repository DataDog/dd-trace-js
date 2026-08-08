'use strict'

const { format } = require('node:url')

const { HttpsProxyAgent } = require('https-proxy-agent')
const { getProxyForUrl } = require('proxy-from-env')
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
    const url = new URL(format({
      protocol: 'https:',
      hostname: `${intake}.${config.site}`,
    }))
    const proxyUrl = getProxyForUrl(url.href)
    const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined

    return {
      url,
      basePath: '',
      headers: {
        'DD-API-KEY': apiKey,
      },
      ...(agent && { agent }),
    }
  } catch (error) {
    log.debug('Unable to configure direct EVP intake: %s', error.message)
  }
}

module.exports = { createDirectEVPRoute }
