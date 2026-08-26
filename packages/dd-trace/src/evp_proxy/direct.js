'use strict'

const { createHash } = require('node:crypto')
const { format } = require('node:url')

const { HttpsProxyAgent } = require('../../../../vendor/dist/https-proxy-agent')
const { getProxyForUrl } = require('../../../../vendor/dist/proxy-from-env')
const log = require('../log')

const API_KEY_FINGERPRINT_HEADER_NAME = 'DD-API-KEY-FINGERPRINT'
const BASE62_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const BASE62_RADIX = 62n
const SHA256_BASE62_LENGTH = 43

/**
 * Creates the stable identifier used alongside direct intake authentication.
 *
 * @param {string} apiKey - Datadog API key
 * @returns {string} Prefixed, fixed-width SHA-256 fingerprint
 */
function createAPIKeyFingerprint (apiKey) {
  const digest = createHash('sha256').update(apiKey).digest()
  let value = BigInt(`0x${digest.toString('hex')}`)
  let encoded = ''

  do {
    encoded = BASE62_ALPHABET[Number(value % BASE62_RADIX)] + encoded
    value /= BASE62_RADIX
  } while (value > 0n)

  return `rijn_${encoded.padStart(SHA256_BASE62_LENGTH, '0')}`
}

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

    return {
      url,
      basePath: '',
      headers: {
        'DD-API-KEY': apiKey,
        [API_KEY_FINGERPRINT_HEADER_NAME]: createAPIKeyFingerprint(apiKey),
      },
      ...(agent && { agent }),
    }
  } catch (error) {
    log.debug('Unable to configure direct EVP intake: %s', error.message)
  }
}

module.exports = { createDirectEVPRoute }
