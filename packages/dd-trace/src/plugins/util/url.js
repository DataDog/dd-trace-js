'use strict'

const net = require('node:net')
const { URL } = require('node:url')

const log = require('../../log')

const HTTP2_HEADER_AUTHORITY = ':authority'
const HTTP2_HEADER_SCHEME = ':scheme'
const HTTP2_HEADER_PATH = ':path'

const PATH_REGEX = /^(?:[a-z]+:\/\/[^?/]+)?(?<path>\/[^?]*)(?:(\?).*)?$/

const INT_SEGMENT = /^[1-9][0-9]+$/ // Integer of size at least 2 (>=10)
const INT_ID_SEGMENT = /^(?=.*[0-9])[0-9._-]{3,}$/ // Mixed string with digits and delimiters
const HEX_SEGMENT = /^(?=.*[0-9])[A-Fa-f0-9]{6,}$/ // Hexadecimal digits of size at least 6 with at least one decimal digit
const HEX_ID_SEGMENT = /^(?=.*[0-9])[A-Fa-f0-9._-]{6,}$/ // Mixed string with hex digits and delimiters
const SPECIAL_CHARACTER_SEGMENT = /[%&'()*+,:=@]/

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MAX_ADMITTED_QUERY_SCHEMAS = 32
const MAX_CANDIDATE_QUERY_SCHEMAS = 64
const MAX_QUERY_STRING_LENGTH = 2048
const MAX_QUERY_PARAMETERS = 16
const MAX_QUERY_KEY_LENGTH = 64
const MAX_QUERY_VALUE_LENGTH = 128
const MAX_QUERY_SCHEMA_LENGTH = 512
const MAX_TRACKED_URL_LENGTH = 2048

const BOOLEAN_SCHEMA = '<boolean>'
const DATE_SCHEMA = '<date>'
const EMPTY_SCHEMA = '<empty>'
const FLAG_SCHEMA = '<flag>'
const HEX_SCHEMA = '<hex>'
const IPV4_SCHEMA = '<IPv4>'
const IPV6_SCHEMA = '<IPv6>'
const KEY_SCHEMA = '<key>'
const MIXED_SCHEMA = '<mixed>'
const NUMBER_SCHEMA = '<number>'
const REDACTED_SCHEMA = '<redacted>'
const STRING_SCHEMA = '<string>'
const TRUNCATED_SCHEMA = '<truncated>'
const UUID_SCHEMA = '<uuid>'

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

  if (obfuscator instanceof RegExp) return obfuscator

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
 * Normalize query parameter names once when a client plugin is configured.
 *
 * @param {string | string[] | Set<string> | undefined} allowlist
 * @returns {Set<string> | undefined}
 */
function normalizeQueryStringAllowlist (allowlist) {
  if (allowlist instanceof Set) return allowlist
  if (allowlist === undefined) return

  const values = typeof allowlist === 'string' ? allowlist.split(',') : allowlist
  if (!Array.isArray(values)) return

  const normalized = new Set()
  for (const value of values) {
    if (typeof value !== 'string') continue

    const key = normalizeQueryComponent(value.trim())
    if (key === '*') return
    if (key !== '') normalized.add(key)
  }
  return normalized
}

class ClientQueryStringSchema {
  /** @type {Set<string>} */
  #admitted = new Set()

  /** @type {Map<string, number>} */
  #candidates = new Map()

  /**
   * Add a bounded, canonical query representation to a client URL.
   *
   * @param {{
   *   queryStringAllowlist?: Set<string>,
   *   queryStringObfuscation?: boolean | string | RegExp,
   *   queryStringTaggingEnabled?: boolean
   * }} config
   * @param {string} pathname
   * @param {string} strippedUrl
   * @param {string} [source]
   * @returns {string}
   */
  getUrl (config, pathname, strippedUrl, source) {
    if (config.queryStringTaggingEnabled === false) return strippedUrl

    const obfuscator = config.queryStringObfuscation === undefined
      ? undefined
      : getQsObfuscator(config)
    if (obfuscator === true) return strippedUrl

    const queryStart = pathname.indexOf('?')
    if (queryStart === -1) return strippedUrl

    const fragmentStart = pathname.indexOf('#', queryStart + 1)
    const queryEnd = fragmentStart === -1 ? pathname.length : fragmentStart
    if (queryStart + 1 === queryEnd) return strippedUrl

    const queryLength = queryEnd - queryStart - 1
    let query
    if (obfuscator === false) {
      if (queryLength > MAX_QUERY_STRING_LENGTH) return strippedUrl
      query = filterRawQuery(pathname, queryStart + 1, queryEnd, config.queryStringAllowlist)
    } else {
      query = buildQuerySchema(config.queryStringAllowlist, obfuscator, pathname, queryStart + 1, queryEnd)
    }
    if (query === undefined) return strippedUrl

    const enrichedUrl = `${strippedUrl}?${query}`
    if (enrichedUrl.length > MAX_TRACKED_URL_LENGTH) return strippedUrl

    if (this.#admitted.has(enrichedUrl)) return enrichedUrl
    if (this.#admitted.size === MAX_ADMITTED_QUERY_SCHEMAS) return strippedUrl

    const candidate = this.#candidates.get(enrichedUrl)
    const sourceShift = querySchemaSourceShift(source)
    if (candidate === undefined) {
      if (this.#candidates.size === MAX_CANDIDATE_QUERY_SCHEMAS) {
        this.#candidates.delete(this.#candidates.keys().next().value)
      }
      this.#candidates.set(enrichedUrl, 1 << sourceShift)
      return strippedUrl
    }

    this.#candidates.delete(enrichedUrl)
    const observations = (candidate >> sourceShift) & 3
    if (observations < 2) {
      this.#candidates.set(enrichedUrl, candidate + (1 << sourceShift))
      return strippedUrl
    }

    this.#admitted.add(enrichedUrl)
    if (this.#admitted.size === MAX_ADMITTED_QUERY_SCHEMAS) {
      this.#candidates.clear()
    }
    return enrichedUrl
  }
}

/**
 * Keep observations from overlapping client integrations independent.
 *
 * @param {string} [source]
 * @returns {number}
 */
function querySchemaSourceShift (source) {
  switch (source) {
    case 'electron:net:request': return 0
    case 'fetch': return 2
    case 'http': return 4
    case 'http2': return 6
    case 'undici': return 8
    case 'undici:request:create': return 10
    default: return 12
  }
}

/**
 * @param {Set<string> | undefined} allowlist
 * @param {RegExp | undefined} obfuscator
 * @param {string} pathname
 * @param {number} queryStart
 * @param {number} queryEnd
 * @returns {string | undefined}
 */
function buildQuerySchema (allowlist, obfuscator, pathname, queryStart, queryEnd) {
  const entries = new Map()
  const boundedEnd = Math.min(queryEnd, queryStart + MAX_QUERY_STRING_LENGTH)
  let truncated = boundedEnd !== queryEnd
  let parameterStart = queryStart
  let parameters = 0

  while (parameterStart < boundedEnd && parameters < MAX_QUERY_PARAMETERS) {
    let parameterEnd = pathname.indexOf('&', parameterStart)
    if (parameterEnd === -1 || parameterEnd > boundedEnd) parameterEnd = boundedEnd

    const separator = pathname.indexOf('=', parameterStart)
    const keyEnd = separator === -1 || separator > parameterEnd ? parameterEnd : separator
    const rawKey = pathname.slice(parameterStart, Math.min(keyEnd, parameterStart + MAX_QUERY_KEY_LENGTH + 1))
    const key = normalizeQueryKey(rawKey)

    if (key !== '' && allowlist?.has(key) !== false) {
      const schemaKey = querySchemaKey(key)
      let valueSchema = FLAG_SCHEMA
      if (separator !== -1 && separator < parameterEnd) {
        const rawValue = pathname.slice(separator + 1, Math.min(parameterEnd, separator + 1 + MAX_QUERY_VALUE_LENGTH))
        valueSchema = matchesObfuscator(obfuscator, pathname.slice(parameterStart, parameterEnd))
          ? REDACTED_SCHEMA
          : queryValueSchema(normalizeQueryComponent(rawValue))
      }

      const previous = entries.get(schemaKey)
      if (previous === undefined) {
        entries.set(schemaKey, valueSchema)
      } else if (previous !== valueSchema) {
        entries.set(schemaKey, MIXED_SCHEMA)
      }
    }

    if (parameterEnd === boundedEnd) {
      parameterStart = boundedEnd
      break
    }
    parameters++
    parameterStart = parameterEnd + 1
  }

  if (parameterStart < queryEnd) truncated = true
  if (entries.size === 0) return

  const schemaEntries = []
  for (const [key, value] of entries) {
    schemaEntries.push(`${key}=${value}`)
  }
  schemaEntries.sort()

  let schema = ''
  for (const entry of schemaEntries) {
    const separator = schema === '' ? '' : '&'
    if (schema.length + separator.length + entry.length > MAX_QUERY_SCHEMA_LENGTH) {
      truncated = true
      break
    }
    schema += separator + entry
  }
  if (truncated && schema.length + TRUNCATED_SCHEMA.length + 1 <= MAX_QUERY_SCHEMA_LENGTH) {
    schema += `&${TRUNCATED_SCHEMA}`
  }
  return schema
}

/**
 * @param {string} pathname
 * @param {number} queryStart
 * @param {number} queryEnd
 * @param {Set<string> | undefined} allowlist
 * @returns {string | undefined}
 */
function filterRawQuery (pathname, queryStart, queryEnd, allowlist) {
  if (allowlist === undefined) return pathname.slice(queryStart, queryEnd)
  if (allowlist.size === 0) return

  let query = ''
  let parameterStart = queryStart
  let parameters = 0
  while (parameterStart < queryEnd && parameters < MAX_QUERY_PARAMETERS) {
    let parameterEnd = pathname.indexOf('&', parameterStart)
    if (parameterEnd === -1 || parameterEnd > queryEnd) parameterEnd = queryEnd
    const separator = pathname.indexOf('=', parameterStart)
    const keyEnd = separator === -1 || separator > parameterEnd ? parameterEnd : separator
    const key = normalizeQueryKey(pathname.slice(parameterStart, keyEnd))

    if (allowlist.has(key)) {
      if (query !== '') query += '&'
      query += pathname.slice(parameterStart, parameterEnd)
    }

    if (parameterEnd === queryEnd) break
    parameters++
    parameterStart = parameterEnd + 1
  }
  return query || undefined
}

/**
 * @param {boolean | RegExp | undefined} obfuscator
 * @param {string} parameter
 * @returns {boolean}
 */
function matchesObfuscator (obfuscator, parameter) {
  if (!(obfuscator instanceof RegExp)) return false

  obfuscator.lastIndex = 0
  const matched = obfuscator.test(parameter)
  obfuscator.lastIndex = 0
  return matched
}

/**
 * @param {string} key
 * @returns {string}
 */
function normalizeQueryKey (key) {
  if (key.length > MAX_QUERY_KEY_LENGTH) return KEY_SCHEMA
  return normalizeQueryComponent(key)
}

/**
 * @param {string} key
 * @returns {string}
 */
function querySchemaKey (key) {
  if (key === KEY_SCHEMA || queryValueSchema(key) !== STRING_SCHEMA) return KEY_SCHEMA
  return encodeURIComponent(key)
}

/**
 * Decode valid query escapes without invoking a throwing URI decoder on malformed input.
 *
 * @param {string} value
 * @returns {string}
 */
function normalizeQueryComponent (value) {
  let normalized
  let hasEscape = false
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code === 43) {
      normalized ??= value.slice(0, index)
      normalized += ' '
    } else if (code === 37) {
      hasEscape = true
      if (normalized !== undefined) normalized += value[index]
    } else if (normalized !== undefined) {
      normalized += value[index]
    }
  }
  normalized ??= value
  return hasEscape && isValidEncodedQueryComponent(normalized) ? decodeURIComponent(normalized) : normalized
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isValidEncodedQueryComponent (value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code !== 37) {
      if (code >= 0xD8_00 && code <= 0xDB_FF) {
        const low = value.charCodeAt(++index)
        if (low < 0xDC_00 || low > 0xDF_FF) return false
      } else if (code >= 0xDC_00 && code <= 0xDF_FF) {
        return false
      }
      continue
    }

    const first = percentEncodedByte(value, index)
    let continuationBytes = 0
    let secondMinimum = 0x80
    let secondMaximum = 0xBF
    if (first < 0) return false
    if (first >= 0xC2 && first <= 0xDF) {
      continuationBytes = 1
    } else if (first >= 0xE0 && first <= 0xEF) {
      continuationBytes = 2
      if (first === 0xE0) {
        secondMinimum = 0xA0
      } else if (first === 0xED) {
        secondMaximum = 0x9F
      }
    } else if (first >= 0xF0 && first <= 0xF4) {
      continuationBytes = 3
      if (first === 0xF0) {
        secondMinimum = 0x90
      } else if (first === 0xF4) {
        secondMaximum = 0x8F
      }
    } else if (first >= 0x80) {
      return false
    }

    for (let offset = 1; offset <= continuationBytes; offset++) {
      const next = percentEncodedByte(value, index + offset * 3)
      const minimum = offset === 1 ? secondMinimum : 0x80
      const maximum = offset === 1 ? secondMaximum : 0xBF
      if (next < minimum || next > maximum) return false
    }
    index += (continuationBytes + 1) * 3 - 1
  }
  return true
}

/**
 * @param {string} value
 * @param {number} index
 * @returns {number}
 */
function percentEncodedByte (value, index) {
  if (value.charCodeAt(index) !== 37 || index + 2 >= value.length) return -1
  const high = hexValue(value.charCodeAt(index + 1))
  const low = hexValue(value.charCodeAt(index + 2))
  return high === -1 || low === -1 ? -1 : high * 16 + low
}

/**
 * @param {number} code
 * @returns {number}
 */
function hexValue (code) {
  if (code >= 48 && code <= 57) return code - 48
  if (code >= 65 && code <= 70) return code - 55
  if (code >= 97 && code <= 102) return code - 87
  return -1
}

/**
 * @param {string} value
 * @returns {string}
 */
function queryValueSchema (value) {
  if (value === '') return EMPTY_SCHEMA
  if (value === 'true' || value === 'false' || value === 'TRUE' || value === 'FALSE') return BOOLEAN_SCHEMA
  if (UUID.test(value)) return UUID_SCHEMA
  if (ISO_DATE.test(value)) return DATE_SCHEMA

  if (value.includes('.') || value.includes(':')) {
    const ipVersion = net.isIP(value)
    if (ipVersion === 4) return IPV4_SCHEMA
    if (ipVersion === 6) return IPV6_SCHEMA
  }
  if (isNumber(value)) return NUMBER_SCHEMA
  if (isHex(value)) return HEX_SCHEMA
  return STRING_SCHEMA
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isNumber (value) {
  let index = value.charCodeAt(0) === 43 || value.charCodeAt(0) === 45 ? 1 : 0
  let digits = 0
  while (index < value.length && isDigit(value.charCodeAt(index))) {
    digits++
    index++
  }
  if (value.charCodeAt(index) === 46) {
    index++
    while (index < value.length && isDigit(value.charCodeAt(index))) {
      digits++
      index++
    }
  }
  if (digits === 0) return false
  if (value.charCodeAt(index) === 69 || value.charCodeAt(index) === 101) {
    index++
    if (value.charCodeAt(index) === 43 || value.charCodeAt(index) === 45) index++
    const exponentStart = index
    while (index < value.length && isDigit(value.charCodeAt(index))) index++
    if (index === exponentStart) return false
  }
  return index === value.length
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isHex (value) {
  if (value.length < 3 || value.charCodeAt(0) !== 48 || (value.charCodeAt(1) | 32) !== 120) return false
  for (let index = 2; index < value.length; index++) {
    if (hexValue(value.charCodeAt(index)) === -1) return false
  }
  return true
}

/**
 * @param {number} code
 * @returns {boolean}
 */
function isDigit (code) {
  return code >= 48 && code <= 57
}

/**
 * Build a client span's `http.url` with its query retained but obfuscated per
 * `config.queryStringObfuscation` (OTel `url.full` is the absolute URL including
 * the redacted query). Falls back to `strippedUrl` when there is no query.
 * Callers gate this behind `DD_TRACE_OTEL_SEMANTICS_ENABLED`, so the default
 * (flag off) hot path stays a plain tag assignment.
 *
 * @param {{ queryStringObfuscation?: boolean | string }} config
 * @param {string} base `scheme://host[:port]`
 * @param {string} [pathname] raw request path, may include `?query`
 * @param {string} strippedUrl `base` + query-stripped path (used when there is no query)
 * @returns {string}
 */
function buildClientHttpUrl (config, base, pathname, strippedUrl) {
  if (pathname?.includes('?')) {
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

    if (element.length >= 20 || SPECIAL_CHARACTER_SEGMENT.test(element)) return '{param:str}'

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
  ClientQueryStringSchema,
  normalizeQueryStringAllowlist,
  calculateHttpEndpoint,
  filterSensitiveInfoFromRepository,
  extractPathFromUrl, // used by http-otel-semantics decomposeServerUrl fallback (and tests)
}
