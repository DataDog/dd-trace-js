'use strict'

const { HttpsProxyAgent } = require('../../../../vendor/dist/https-proxy-agent')
const { getProxyForUrl } = require('../../../../vendor/dist/proxy-from-env')
const { createSiteUrl } = require('../exporters/common/url')
const log = require('../log')

/** @type {Map<string, import('node:https').Agent>} */
const proxyAgents = new Map()

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
    const url = createSiteUrl(config.site, intake)
    if (url === undefined) throw new Error('Invalid direct EVP intake URL')

    const agent = getHttpsProxyAgent(url.href)

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

/**
 * @param {string} url
 * @returns {import('node:https').Agent|undefined}
 */
function getHttpsProxyAgent (url) {
  const proxyUrl = getProxyForUrl(url)
  if (!proxyUrl) return

  let agent = proxyAgents.get(proxyUrl)
  if (agent === undefined) {
    agent = new HttpsProxyAgent(proxyUrl)
    proxyAgents.set(proxyUrl, agent)
  }
  return agent
}

module.exports = { createDirectEVPRoute, getHttpsProxyAgent }
