'use strict'

const { createSiteUrl } = require('../exporters/common/url')
const log = require('../log')

/**
 * @typedef {object} DirectEVPRoute
 * @property {URL} url - Direct intake URL
 * @property {string} basePath - Direct intake base path
 * @property {object} headers - Direct intake authentication headers
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

    return {
      url,
      basePath: '',
      headers: {
        'DD-API-KEY': apiKey,
      },
    }
  } catch (error) {
    log.debug('Unable to configure direct EVP intake: %s', error.message)
  }
}

module.exports = { createDirectEVPRoute }
