'use strict'

const web = require('../plugins/util/web')
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

  const hashed = (globalRequestCounter * KNUTH_FACTOR) % UINT64_MAX
  const threshold = BigInt(Math.round(samplingRate * Number(UINT64_MAX)))

  return hashed <= threshold
}

function incrementBodyAnalysisCount (req) {
  const currentCount = perRequestBodyAnalysisCount.get(req) || 0
  perRequestBodyAnalysisCount.set(req, currentCount + 1)
}

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

function extractResponseData (res, includeBody, responseBody) {
  const addresses = {}

  if (res.statusCode !== undefined && res.statusCode !== null) {
    addresses[HTTP_OUTGOING_RESPONSE_STATUS] = String(res.statusCode)
  }

  const headers = res.headers
  if (headers && Object.keys(headers).length > 0) {
    addresses[HTTP_OUTGOING_RESPONSE_HEADERS] = headers
  }

  if (includeBody && responseBody) {
    // Parse the body based on content-type
    const contentType = getResponseContentType(res.headers)
    const body = parseBody(responseBody, contentType)

    if (body !== null && body !== undefined) {
      addresses[HTTP_OUTGOING_RESPONSE_BODY] = body
    }
  }

  return addresses
}

function incrementDownstreamAnalysisCount (req) {
  const currentCount = perRequestDownstreamAnalysisCount.get(req) || 0
  perRequestDownstreamAnalysisCount.set(req, currentCount + 1)

  const span = web.root(req)

  if (span) {
    span.setTag('_dd.appsec.downstream_request', currentCount + 1)
  }
}

function handleResponseTracing (req, raspRule) {
  updateRaspRuleMatchMetricTags(req, raspRule, false, false)
}

function determineMethod (method) {
  return typeof method === 'string' && method ? method : 'GET'
}

function getResponseContentType (headers) {
  if (!headers) return null

  return headers['content-type'] || headers['Content-Type'] || headers['CONTENT-TYPE'] || null
}

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
