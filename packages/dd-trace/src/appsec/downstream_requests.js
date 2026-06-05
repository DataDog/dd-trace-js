'use strict'

const web = require('../plugins/util/web')
const log = require('../log')
const {
  HTTP_OUTGOING_METHOD,
  HTTP_OUTGOING_HEADERS,
  HTTP_OUTGOING_RESPONSE_STATUS,
  HTTP_OUTGOING_RESPONSE_HEADERS,
  HTTP_OUTGOING_RESPONSE_BODY,
} = require('./addresses')

const KNUTH_FACTOR = 11400714819323199488n // eslint-disable-line unicorn/numeric-separators-style
const UINT64_MAX = (1n << 64n) - 1n

const SUPPORTED_RESPONSE_BODY_MIME_TYPES = new Set([
  'application/json',
  'text/json',
  'application/x-www-form-urlencoded',
])

const RESPONSE_BODY_IGNORED_TAG_CONTENT_TYPE =
  '_dd.appsec.downstream_request.response_body_ignored.content_type_invalid'
const RESPONSE_BODY_IGNORED_TAG_CONTENT_LENGTH_MISSING =
  '_dd.appsec.downstream_request.response_body_ignored.content_length_missing'
const RESPONSE_BODY_IGNORED_TAG_CONTENT_LENGTH_TOO_BIG =
  '_dd.appsec.downstream_request.response_body_ignored.content_length_too_big'

let config
let samplingRate
let globalRequestCounter
let bodyAnalysisCount
let downstreamAnalysisCount
let responseBodyIgnoredCount

function enable (_config) {
  config = _config
  globalRequestCounter = 0n
  bodyAnalysisCount = new WeakMap()
  downstreamAnalysisCount = new WeakMap()
  responseBodyIgnoredCount = new WeakMap()

  const bodyAnalysisSampleRate = config.appsec.apiSecurity?.downstreamBodyAnalysisSampleRate
  samplingRate = Math.min(Math.max(bodyAnalysisSampleRate, 0), 1)

  if (samplingRate !== bodyAnalysisSampleRate) {
    log.warn(
      'DD_API_SECURITY_DOWNSTREAM_BODY_ANALYSIS_SAMPLE_RATE value is %s and it\'s out of range',
      bodyAnalysisSampleRate)
  }
}

function disable () {
  config = null
  globalRequestCounter = null
  bodyAnalysisCount = null
  downstreamAnalysisCount = null
  responseBodyIgnoredCount = null
}

/**
 * @param {string|string[]|undefined} contentLength raw content-length header value.
 * @returns {number|null} parsed content length or null when invalid.
 */
function parseContentLengthHeader (contentLength) {
  if (contentLength == null) {
    return null
  }

  const value = Array.isArray(contentLength) ? contentLength[0] : contentLength
  const parsed = Number.parseInt(String(value), 10)

  if (!Number.isFinite(parsed) || parsed < 0) {
    return null
  }

  return parsed
}

/**
 * Increments a response-body-ignored counter on the service-entry span.
 * @param {import('http').IncomingMessage} req originating request.
 * @param {string} tag full `_dd.appsec.downstream_request.response_body_ignored.*` span tag.
 */
function recordResponseBodyIgnored (req, tag) {
  const span = web.root(req)
  if (!span) return

  let counts = responseBodyIgnoredCount.get(req)
  if (!counts) {
    counts = {}
    responseBodyIgnoredCount.set(req, counts)
  }

  const current = counts[tag] || 0
  const next = current + 1
  counts[tag] = next
  span.setTag(tag, next)
}

/**
 * @param {import('http').IncomingMessage} originatingReq inbound request (for metrics).
 * @param {import('http').IncomingMessage} res downstream response.
 * @returns {boolean} whether downstream response body should be collected for AppSec.
 */
function evaluateResponseBodyCollection (originatingReq, res) {
  const maxBytes = config.appsec.apiSecurity.maxDownstreamBodyBytes

  const mime = extractMimeType(res.headers?.['content-type'])
  if (!mime || !SUPPORTED_RESPONSE_BODY_MIME_TYPES.has(mime)) {
    recordResponseBodyIgnored(originatingReq, RESPONSE_BODY_IGNORED_TAG_CONTENT_TYPE)
    return false
  }

  const declaredContentLength = parseContentLengthHeader(res.headers?.['content-length'])
  if (declaredContentLength == null || declaredContentLength === 0) {
    recordResponseBodyIgnored(originatingReq, RESPONSE_BODY_IGNORED_TAG_CONTENT_LENGTH_MISSING)
    return false
  }

  if (declaredContentLength > maxBytes) {
    recordResponseBodyIgnored(originatingReq, RESPONSE_BODY_IGNORED_TAG_CONTENT_LENGTH_TOO_BIG)
    return false
  }

  return true
}

/**
 * Probabilistic gate for downstream response body capture (rate + per-request cap).
 * Only used from {@link planResponseBodyCollection}; does not increment {@link bodyAnalysisCount}.
 * @param {import('http').IncomingMessage} req originating server request.
 * @param {string} [_outgoingUrl] reserved for future use.
 * @returns {boolean}
 */
function shouldSampleBody (req, _outgoingUrl) {
  globalRequestCounter = (globalRequestCounter + 1n) & UINT64_MAX

  const currentCount = bodyAnalysisCount.get(req) || 0
  if (currentCount >= config.appsec.apiSecurity?.maxDownstreamRequestBodyAnalysis) {
    return false
  }

  const hashed = (globalRequestCounter * KNUTH_FACTOR) % UINT64_MAX
  // Replace 1000n with the accuraccy that we want to maintain
  const threshold = (UINT64_MAX * BigInt(Math.round(samplingRate * 1000))) / 1000n

  return hashed <= threshold
}

/**
 * @param {import('http').IncomingMessage} res downstream HTTP response.
 * @returns {boolean}
 */
function isRedirectResponse (res) {
  const location = res.headers?.location || res.headers?.Location
  return res.statusCode >= 300 && res.statusCode < 400 && !!location
}

/**
 * Plans downstream response body capture on the instrumentation ctx when response headers arrive.
 * Redirect responses (3xx + Location) are ignored; each outbound hop is evaluated independently
 * when its own non-redirect response arrives.
 * @param {import('http').IncomingMessage} originatingReq incoming server request.
 * @param {string} _outgoingUrl downstream URL for this hop (unused; redirect hops exit earlier).
 * @param {import('http').IncomingMessage} res downstream response.
 * @param {object} ctx http client instrumentation context (mutated).
 */
function planResponseBodyCollection (originatingReq, _outgoingUrl, res, ctx) {
  if (!config?.appsec.apiSecurity) {
    return
  }

  if (isRedirectResponse(res)) {
    return
  }

  if (!shouldSampleBody(originatingReq, _outgoingUrl)) {
    return
  }

  if (evaluateResponseBodyCollection(originatingReq, res)) {
    ctx.shouldCollectBody = true
    incrementBodyAnalysisCount(originatingReq)
  }
}

/**
 * Increments the number of downstream body analyses performed for the given request.
 * @param {import('http').IncomingMessage} req outgoing request.
 */
function incrementBodyAnalysisCount (req) {
  const currentCount = bodyAnalysisCount.get(req) || 0
  bodyAnalysisCount.set(req, currentCount + 1)
}

/**
 *
 * @param {object} headers
 * @returns {object} the headers with all keys converted to lowercase
 */
function lowercaseHeaderKeys (headers) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
}

/**
 * Extracts request data from the context for WAF analysis
 * @param {object} ctx context for the outgoing downstream request.
 * @returns {object} a map of addresses and request data.
 */
function extractRequestData (ctx) {
  const addresses = {}

  const options = ctx?.args?.options || {}

  addresses[HTTP_OUTGOING_METHOD] = getMethod(options.method)

  const headers = options?.headers
  if (headers && Object.keys(headers).length > 0) {
    addresses[HTTP_OUTGOING_HEADERS] = lowercaseHeaderKeys(headers)
  }

  return addresses
}

/**
 * Extracts response data for WAF analysis.
 * @param {import('http').IncomingMessage} res downstream response object.
 * @param {Buffer|string|object|null} responseBody response body.
 * @returns {object} a map of addresses and response data.
 */
function extractResponseData (res, responseBody) {
  const addresses = {}

  if (res.statusCode) {
    addresses[HTTP_OUTGOING_RESPONSE_STATUS] = String(res.statusCode)
  }

  const headers = res.headers
  if (headers && Object.keys(headers).length > 0) {
    addresses[HTTP_OUTGOING_RESPONSE_HEADERS] = headers
  }

  if (responseBody) {
    // Parse the body based on content-type
    const contentType = res.headers?.['content-type']
    const body = parseBody(responseBody, contentType)

    if (body) {
      addresses[HTTP_OUTGOING_RESPONSE_BODY] = body
    }
  }

  return addresses
}

/**
 * Tracks how many downstream analyses were executed for a given request and updates tracing tags.
 * @param {import('http').IncomingMessage} req outgoing request.
 */
function incrementDownstreamAnalysisCount (req) {
  const currentCount = downstreamAnalysisCount.get(req) || 0
  downstreamAnalysisCount.set(req, currentCount + 1)

  const span = web.root(req)

  if (span) {
    span.setTag('_dd.appsec.downstream_request', currentCount + 1)
  }
}

/**
 * Returns the HTTP method to use for a downstream request, defaulting to GET.
 * @param {string} method method supplied in the outgoing request options.
 * @returns {string} validated HTTP method.
 */
function getMethod (method) {
  return typeof method === 'string' && method ? method : 'GET'
}

/**
 * Parses a downstream response body.
 * @param {Buffer|string|object|null} body raw response body
 * @param {string|null} contentType response content-type used to select the parser.
 * @returns {object|null} parsed body object or null when not supported.
 */
function parseBody (body, contentType) {
  if (!body || !contentType) {
    return null
  }

  const mime = extractMimeType(contentType)

  try {
    if (mime === 'application/json' || mime === 'text/json') {
      if (typeof body === 'string') {
        return JSON.parse(body)
      }

      if (Buffer.isBuffer(body)) {
        return JSON.parse(body.toString('utf8'))
      }

      return null
    }

    if (mime === 'application/x-www-form-urlencoded') {
      const formBody = Buffer.isBuffer(body) ? body.toString('utf8') : String(body)
      const params = new URLSearchParams(formBody)
      const result = {}
      for (const [key, value] of params.entries()) {
        if (key in result) {
          const existing = result[key]
          if (Array.isArray(existing)) {
            existing.push(value)
          } else {
            result[key] = [existing, value]
          }
        } else {
          result[key] = value
        }
      }

      return result
    }

    // multipart/form-data is mentioned in RFC but parsing is complex.
    // Other content-types also discarded per RFC

    return null
  } catch {
    // Parsing failed: return null to avoid sending malformed body to WAF
    return null
  }
}

/**
 * Extracts the MIME type portion of a content-type header value.
 * @param {string|null} contentType raw content-type header value.
 * @returns {string|null} lowercase mime type
 */
function extractMimeType (contentType) {
  if (typeof contentType !== 'string') {
    return null
  }

  return contentType.split(';', 1)[0].trim().toLowerCase()
}

module.exports = {
  enable,
  disable,
  planResponseBodyCollection,
  incrementDownstreamAnalysisCount,
  extractRequestData,
  extractResponseData,
}
