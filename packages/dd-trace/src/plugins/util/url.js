'use strict'

const { URL } = require('url')

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
  return (req.socket?.encrypted || req.connection?.encrypted) ? 'https' : 'http'
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

  const endpoint = normalizedElements.length > 0
    ? '/' + normalizedElements.join('/')
    : '/'

  return endpoint
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
  calculateHttpEndpoint,
  filterSensitiveInfoFromRepository,
  extractPathFromUrl // test only
}
