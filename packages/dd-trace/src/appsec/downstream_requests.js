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

let config
let samplingRate
let globalRequestCounter
let bodyAnalysisCount
let downstreamAnalysisCount
let redirectBodyCollectionDecisions

function enable (_config) {
  config = _config
  globalRequestCounter = 0n
  bodyAnalysisCount = new WeakMap()
  downstreamAnalysisCount = new WeakMap()
  redirectBodyCollectionDecisions = new WeakMap()

  const bodyAnalysisSampleRate = config.appsec.apiSecurity?.downstreamRequestBodyAnalysisSampleRate
  samplingRate = Math.min(Math.max(bodyAnalysisSampleRate, 0), 1)

  if (samplingRate !== bodyAnalysisSampleRate) {
    log.warn(
      'DD_API_SECURITY_DOWNSTREAM_REQUEST_BODY_ANALYSIS_SAMPLE_RATE value is %s and it\'s out of range',
      bodyAnalysisSampleRate)
  }
}

function disable () {
  config = null
  globalRequestCounter = null
  bodyAnalysisCount = null
  downstreamAnalysisCount = null
  redirectBodyCollectionDecisions = null
}

/**
 * Check we have a stored redirect body collection decision for a given URL.
 * @param {import('http').IncomingMessage} req outgoing request.
 * @param {string} outgoingUrl the URL being requested.
 * @returns {boolean} the stored decision
 */
function consumeRedirectBodyCollectionDecision (req, outgoingUrl) {
  const decisions = redirectBodyCollectionDecisions.get(req)
  if (!decisions) return false

  return decisions.delete(outgoingUrl)
}

/**
 * Stores a redirect body collection decision for a follow-up request.
 * @param {import('http').IncomingMessage} req outgoing request.
 * @param {string} redirectUrl the URL to redirect to.
 */
function storeRedirectBodyCollectionDecision (req, redirectUrl) {
  let decisions = redirectBodyCollectionDecisions.get(req)

  if (!decisions) {
    decisions = new Set()
    redirectBodyCollectionDecisions.set(req, decisions)
  }

  decisions.add(redirectUrl)
}

/**
 * Determines whether the current downstream request/responses bodies should be sampled for analysis.
 * @param {import('http').IncomingMessage} req outgoing request.
 * @param {string} outgoingUrl the URL being requested (to check for redirect decisions).
 * @returns {boolean} true when the downstream response body should be captured.
 */
function shouldSampleBody (req, outgoingUrl) {
  // Check if there's a stored decision from a previous redirect
  const storedDecision = consumeRedirectBodyCollectionDecision(req, outgoingUrl)
  if (storedDecision) return true

  globalRequestCounter = (globalRequestCounter + 1n) & UINT64_MAX

  const currentCount = bodyAnalysisCount.get(req) || 0
  if (currentCount >= config.appsec.apiSecurity?.maxDownstreamRequestBodyAnalysis) {
    return false
  }

  const hashed = (globalRequestCounter * KNUTH_FACTOR) % UINT64_MAX
  // Replace 1000n with the accuraccy that we want to maintain
  const threshold = (UINT64_MAX * BigInt(Math.round(samplingRate * 1000))) / 1000n

  const shouldCollectBody = hashed <= threshold

  // Track body analysis count if we're sampling the response body
  if (shouldCollectBody) {
    incrementBodyAnalysisCount(req)
  }

  return shouldCollectBody
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
    addresses[HTTP_OUTGOING_HEADERS] = headers
  }

  return addresses
}

/**
 * Checks if a response is a redirect
 * @param {import('http').IncomingMessage} req outgoing request.
 * @param {import('http').IncomingMessage} res downstream response object.
 * @returns {boolean} is redirect.
 */
function handleRedirectResponse (req, res) {
  const isRedirect = res.statusCode >= 300 && res.statusCode < 400
  const redirectLocation = res.headers?.location || ''

  if (isRedirect && redirectLocation) {
    // Store the body collection decision for the redirect target
    storeRedirectBodyCollectionDecision(req, redirectLocation)
  }

  return isRedirect
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
  shouldSampleBody,
  handleRedirectResponse,
  incrementDownstreamAnalysisCount,
  extractRequestData,
  extractResponseData,
  // exports for tests
  parseBody,
  getMethod,
  storeRedirectBodyCollectionDecision,
}
