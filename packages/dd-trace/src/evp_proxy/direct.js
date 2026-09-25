'use strict'

const { createSiteUrl } = require('../exporters/common/url')
const log = require('../log')

let invalidSiteWarningLogged = false

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
  if (!apiKey) return

  const url = createSiteUrl(config.site, intake)
  if (url === undefined) {
    if (!invalidSiteWarningLogged) {
      invalidSiteWarningLogged = true
      log.warn('Feature Flags direct event delivery is disabled because DD_SITE is invalid.')
    }
    return
  }

  return {
    url,
    basePath: '',
    headers: {
      'DD-API-KEY': apiKey,
    },
  }
}

module.exports = { createDirectEVPRoute }
