'use strict'

const { EVP_SUBDOMAIN_HEADER_NAME } = require('../../evp_proxy/constants')
const { joinEVPProxyPath } = require('../../evp_proxy/path')

/**
 * @typedef {object} ApiRequestRouteOptions
 * @property {URL} url
 * @property {string} path
 * @property {boolean} isEvpProxy
 * @property {string} evpProxyPrefix
 */

/**
 * @typedef {object} ApiRequestRoute
 * @property {URL} url
 * @property {string} path
 * @property {Record<string, string>} headers
 */

/**
 * @param {import('../../config/config-base')} config
 * @param {ApiRequestRouteOptions} options
 * @returns {ApiRequestRoute|undefined}
 */
function createApiRequestRoute (config, { url, path, isEvpProxy, evpProxyPrefix }) {
  if (isEvpProxy) {
    return {
      url,
      path: joinEVPProxyPath(evpProxyPrefix, path),
      headers: { [EVP_SUBDOMAIN_HEADER_NAME]: 'api' },
    }
  }

  if (config.DD_API_KEY === undefined) return

  return {
    url,
    path,
    headers: { 'dd-api-key': config.DD_API_KEY },
  }
}

module.exports = { createApiRequestRoute }
