'use strict'

const web = require('../plugins/util/web')
const log = require('../log')
const { updateRaspRuleMatchMetricTags } = require('./telemetry')
const {
  HTTP_OUTGOING_METHOD,
  HTTP_OUTGOING_HEADERS,
  HTTP_OUTGOING_RESPONSE_STATUS,
  HTTP_OUTGOING_RESPONSE_HEADERS,
  HTTP_OUTGOING_RESPONSE_BODY
} = require('./addresses')

const KNUTH_FACTOR = 11400714819323199488n // eslint-disable-line unicorn/numeric-separators-style
const UINT64_MAX = (1n << 64n) - 1n

let config
let globalRequestCounter
let perRequestBodyAnalysisCount
let perRequestDownstreamAnalysisCount

function enable (_config) {
  config = _config
  globalRequestCounter = 0n
  perRequestBodyAnalysisCount = new WeakMap()
  perRequestDownstreamAnalysisCount = new WeakMap()
}

function disable () {
  config = null
  globalRequestCounter = 0n
  perRequestBodyAnalysisCount = new WeakMap()
  perRequestDownstreamAnalysisCount = new WeakMap()
}

/**
 * Determines whether the current downstream request/responses bodies should be sampled for analysis.
 * @param {import('http').IncomingMessage} req inbound request associated with the downstream call.
 * @returns {boolean} true when the downstream response body should be captured.
 */
function shouldSampleBody (req) {
  globalRequestCounter = (globalRequestCounter + 1n) & UINT64_MAX

  const {
    maxDownstreamRequestBodyAnalysis,
    downstreamRequestBodyAnalysisSampleRate
  } = config.appsec.apiSecurity

  const currentCount = perRequestBodyAnalysisCount.get(req) || 0
  if (currentCount >= maxDownstreamRequestBodyAnalysis) {
    return false
  }

  const samplingRate = Math.min(Math.max(downstreamRequestBodyAnalysisSampleRate, 0), 1)

  if (samplingRate !== downstreamRequestBodyAnalysisSampleRate) {
    log.warn(
      'DD_API_SECURITY_DOWNSTREAM_REQUEST_BODY_ANALYSIS_SAMPLE_RATE value is %s and it\'s out of range',
      downstreamRequestBodyAnalysisSampleRate)
  }

  const hashed = (globalRequestCounter * KNUTH_FACTOR) % UINT64_MAX
  // Replace 1000n with the accuraccy that we want to maintain
  const threshold = (UINT64_MAX * BigInt(Math.round(samplingRate * 1000))) / 1000n

  return hashed <= threshold
}

/**
 * Increments the number of downstream body analyses performed for the given request.
 * @param {import('http').IncomingMessage} req inbound request associated with the downstream call.
 */
function incrementBodyAnalysisCount (req) {
  const currentCount = perRequestBodyAnalysisCount.get(req) || 0
  perRequestBodyAnalysisCount.set(req, currentCount + 1)
}

/**
 * Extracts request data from the context for WAF analysis
 * @param {object} ctx context for the outgoing downstream request.
 * @returns {object} a map of addresses and request data.
 */
function extractRequestData (ctx) {
  const addresses = {}

  const options = ctx?.args?.options || {}

  addresses[HTTP_OUTGOING_METHOD] = determineMethod(options.method)

  const headers = options?.headers
  if (headers && Object.keys(headers).length > 0) {
    addresses[HTTP_OUTGOING_HEADERS] = headers
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

  if (res.statusCode !== undefined && res.statusCode !== null) {
    addresses[HTTP_OUTGOING_RESPONSE_STATUS] = String(res.statusCode)
  }

  const headers = res.headers
  if (headers && Object.keys(headers).length > 0) {
    addresses[HTTP_OUTGOING_RESPONSE_HEADERS] = headers
  }

  if (responseBody) {
    // Parse the body based on content-type
    const contentType = getResponseContentType(res.headers)
    const body = parseBody(responseBody, contentType)

    if (body !== null && body !== undefined) {
      addresses[HTTP_OUTGOING_RESPONSE_BODY] = body
    }
  }

  return addresses
}

/**
 * Tracks how many downstream analyses were executed for a given request and updates tracing tags.
 * @param {import('http').IncomingMessage} req inbound request associated with the downstream call.
 */
function incrementDownstreamAnalysisCount (req) {
  const currentCount = perRequestDownstreamAnalysisCount.get(req) || 0
  perRequestDownstreamAnalysisCount.set(req, currentCount + 1)

  const span = web.root(req)

  if (span) {
    span.setTag('_dd.appsec.downstream_request', currentCount + 1)
  }
}

/**
 * Adds tracing telemetry for matches triggered by downstream responses.
 * @param {import('http').IncomingMessage} req inbound request associated with the downstream call.
 * @param {object} raspRule rule with type and variant
 */
function handleResponseTracing (req, raspRule) {
  updateRaspRuleMatchMetricTags(req, raspRule, false, false)
}

/**
 * Returns the HTTP method to use for a downstream request, defaulting to GET.
 * @param {string} method method supplied in the outgoing request options.
 * @returns {string} validated HTTP method.
 */
function determineMethod (method) {
  return typeof method === 'string' && method ? method : 'GET'
}

/**
 * Gets the content-type header value from a case-insensitive headers object.
 * @param {import('http').IncomingHttpHeaders|object|null} headers response headers object.
 * @returns {string|null} content-type value
 */
function getResponseContentType (headers) {
  if (!headers) return null

  return headers['content-type'] || headers['Content-Type'] || headers['CONTENT-TYPE'] || null
}

/**
 * Parses a downstream response body.
 * @param {Buffer|string|object|null} body raw response body
 * @param {string|null} contentType response content-type used to select the parser.
 * @returns {object|null} parsed body object or null when not supported.
 */
function parseBody (body, contentType) {
  if (body === null || body === undefined || !contentType) {
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

      if (typeof body === 'object' && body !== null) {
        return body
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
  shouldSampleBody,
  incrementBodyAnalysisCount,
  incrementDownstreamAnalysisCount,
  extractRequestData,
  extractResponseData,
  handleResponseTracing,
  // exports for tests
  parseBody,
  getResponseContentType,
  determineMethod
}
