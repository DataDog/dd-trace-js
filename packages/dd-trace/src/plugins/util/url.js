'use strict'

const { URL } = require('url')

const log = require('../../log')

const HTTP2_HEADER_AUTHORITY = ':authority'
const HTTP2_HEADER_SCHEME = ':scheme'
const HTTP2_HEADER_PATH = ':path'

const PATH_REGEX = /^(?:[a-z]+:\/\/(?:[^?/]+))?(?<path>\/[^?]*)(?:(\?).*)?$/

const INT_SEGMENT = /^[1-9][0-9]+$/ // Integer of size at least 2 (>=10)
const INT_ID_SEGMENT = /^(?=.*[0-9].*)[0-9._-]{3,}$/ // Mixed string with digits and delimiters
const HEX_SEGMENT = /^(?=.*[0-9].*)[A-Fa-f0-9]{6,}$/ // Hexadecimal digits of size at least 6 with at least one decimal digit
const HEX_ID_SEGMENT = /^(?=.*[0-9].*)[A-Fa-f0-9._-]{6,}$/ // Mixed string with hex digits and delimiters
const STRING_SEGMENT = /^.{20,}|.*[%&'()*+,:=@].*$/ // Long string or a string containing special characters

/**
 * Extract full URL from HTTP request
 * @param {import('http').IncomingMessage} req
 * @returns {string} Full URL
 */
function extractURL (req) {
  const headers = req.headers

  if (req.stream) {
    return `${headers[HTTP2_HEADER_SCHEME]}://${headers[HTTP2_HEADER_AUTHORITY]}${headers[HTTP2_HEADER_PATH]}`
  }

  const protocol = getProtocol(req)
  return `${protocol}://${req.headers.host}${req.originalUrl || req.url}`
}

function getProtocol (req) {
  // Do not check deprecated `req.connection` property.
  return req.socket?.encrypted ? 'https' : 'http'
}

/**
 * Obfuscate query string
 *
 * @param {object} config
 * @param {string} url
 * @returns {string} obfuscated URL
 */
function obfuscateQs (config, url) {
  const { queryStringObfuscation } = config

  if (queryStringObfuscation === false) return url

  const i = url.indexOf('?')
  if (i === -1) return url

  const path = url.slice(0, i)
  if (queryStringObfuscation === true) return path

  let qs = url.slice(i + 1)

  qs = qs.replace(queryStringObfuscation, '<redacted>')

  return `${path}?${qs}`
}

const qsObfuscatorCache = new Map()

/**
 * Compile the configured query-string obfuscator (a regex string, or a boolean)
 * into the boolean / RegExp form that `obfuscateQs` consumes. The compiled regex
 * is cached, since the configuration is stable for the process lifetime.
 *
 * @param {{ queryStringObfuscation?: boolean | string }} config
 * @returns {boolean | RegExp}
 */
function getQsObfuscator (config) {
  const obfuscator = config.queryStringObfuscation

  if (typeof obfuscator === 'boolean') return obfuscator

  if (typeof obfuscator === 'string') {
    const cached = qsObfuscatorCache.get(obfuscator)
    if (cached !== undefined) return cached

    let compiled = true
    if (obfuscator === '') {
      compiled = false // disable obfuscator
    } else if (obfuscator !== '.*') { // '.*' optimizes to a full redact (true)
      try {
        compiled = new RegExp(obfuscator, 'gi')
      } catch (err) {
        log.error('Error getting qs obfuscator', err)
      }
    }

    qsObfuscatorCache.set(obfuscator, compiled)
    return compiled
  }

  if (Object.hasOwn(config, 'queryStringObfuscation')) {
    log.error('Expected `queryStringObfuscation` to be a regex string or boolean.')
  }

  return true
}

/**
 * Resolve the `http.url` tag for a client span. By default the query string is
 * dropped (the long-standing Datadog client behavior, preserved for the URL
 * filter). When OTel semantics are enabled, the query is retained but obfuscated
 * per `config.queryStringObfuscation`, since OTel `url.full` is the absolute URL
 * including the (redacted) query.
 *
 * @param {{ DD_TRACE_OTEL_SEMANTICS_ENABLED?: boolean, queryStringObfuscation?: boolean | RegExp }} config
 * @param {string} base `scheme://host[:port]`
 * @param {string} [pathname] raw request path, may include `?query`
 * @param {string} strippedUrl `base` + query-stripped path (used unless OTel semantics are on)
 * @returns {string}
 */
function buildClientHttpUrl (config, base, pathname, strippedUrl) {
  if (config.DD_TRACE_OTEL_SEMANTICS_ENABLED && pathname?.includes('?')) {
    // `config.queryStringObfuscation` is the raw config value here (client plugins
    // don't normalize it the way the server does), so compile it first.
    return obfuscateQs({ queryStringObfuscation: getQsObfuscator(config) }, `${base}${pathname}`)
  }
  return strippedUrl
}

/**
 * Extract URL path from URL using regex pattern instead of Node.js URL API because:
 *
 * - Handles edge cases like malformed URLs
 * - Works with relative paths
 * - Cross tracers compatibility
 *
 * @param {string} url
 * @returns {string} Url path
 */
function extractPathFromUrl (url) {
  if (!url) return '/'
  const match = url.match(PATH_REGEX)

  return match?.groups?.path || '/'
}

/**
 * Calculate http.endpoint from URL path
 *
 * @param {string} url
 * @returns {string} The normalized endpoint
 */
function calculateHttpEndpoint (url) {
  const path = extractPathFromUrl(url)

  // Split path by '/' and filter empty elements
  const elements = path.split('/').filter(Boolean)

  // Keep only first 8 non-empty elements
  const limitedElements = elements.slice(0, 8)

  // Apply regex replacements to each element respecting this order
  const normalizedElements = limitedElements.map(element => {
    if (INT_SEGMENT.test(element)) return '{param:int}'

    if (INT_ID_SEGMENT.test(element)) return '{param:int_id}'

    if (HEX_SEGMENT.test(element)) return '{param:hex}'

    if (HEX_ID_SEGMENT.test(element)) return '{param:hex_id}'

    if (STRING_SEGMENT.test(element)) return '{param:str}'

    // No match
    return element
  })

  return normalizedElements.length > 0
    ? '/' + normalizedElements.join('/')
    : '/'
}

function filterSensitiveInfoFromRepository (repositoryUrl) {
  if (!repositoryUrl) {
    return ''
  }
  if (repositoryUrl.startsWith('git@')) {
    return repositoryUrl
  }

  // Remove the username from ssh URLs
  if (repositoryUrl.startsWith('ssh://')) {
    const sshRegex = /^(ssh:\/\/)[^@/]*@/
    return repositoryUrl.replace(sshRegex, '$1')
  }

  try {
    const { protocol, host, pathname } = new URL(repositoryUrl)

    return `${protocol}//${host}${pathname === '/' ? '' : pathname}`
  } catch {
    return ''
  }
}

module.exports = {
  extractURL,
  obfuscateQs,
  getQsObfuscator,
  buildClientHttpUrl,
  calculateHttpEndpoint,
  filterSensitiveInfoFromRepository,
  extractPathFromUrl, // used by http-otel-semantics decomposeServerUrl fallback (and tests)
}
