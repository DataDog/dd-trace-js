'use strict'

const { readFileSync } = require('node:fs')
const { extname } = require('node:path')

const getConfig = require('../../config')
const request = require('../../exporters/common/request')
const log = require('../../log')

const UPLOAD_TIMEOUT_MS = 30_000
const TEST_SCREENSHOT_ENDPOINT_PREFIX = '/api/v2/ci/test-runs/'
const TEST_SCREENSHOT_ENDPOINT_SUFFIX = '/media'
const UINT64_MAX = 18_446_744_073_709_551_615n

function getContentType (filePath) {
  const extension = extname(filePath).toLowerCase()
  if (extension === '.gif') {
    return 'image/gif'
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    return 'image/jpeg'
  }
  if (extension === '.webp') {
    return 'image/webp'
  }
  return 'image/png'
}

function isValidTraceId (traceId) {
  if (!/^[1-9]\d*$/.test(traceId)) {
    return false
  }
  return BigInt(traceId) <= UINT64_MAX
}

/**
 * Renders the idempotency key (`${traceId}:${basename(filePath)}`) into a value safe to carry in
 * the upload's query string. The Agent's evp_proxy validates the forwarded query against a
 * restrictive charset and rejects a raw Cypress filename (spaces, parens, non-ASCII), so the
 * filename part is hex-encoded to [0-9a-f]; the decimal trace id and ':' separator are already in
 * the allowed set and stay readable. Deterministic, so a retried upload reproduces the same key
 * and the backend's UUIDv5 overwrite-on-retry holds.
 *
 * @param {string} idempotencyKey - The raw idempotency key (`<traceId>:<filename>`)
 * @returns {string} A query-safe, deterministic representation of the key
 */
function toIdempotencyQueryValue (idempotencyKey) {
  const separatorIndex = idempotencyKey.indexOf(':')
  if (separatorIndex === -1) {
    return Buffer.from(idempotencyKey, 'utf8').toString('hex')
  }
  const traceIdPart = idempotencyKey.slice(0, separatorIndex)
  const filenamePart = idempotencyKey.slice(separatorIndex + 1)
  return `${traceIdPart}:${Buffer.from(filenamePart, 'utf8').toString('hex')}`
}

/**
 * Uploads a single test screenshot to the Test Optimization media intake.
 * The trace id is included in the request path and the body is the raw image bytes.
 *
 * The media service requires two values from the tracer, sent as query params so they
 * survive the Agent's evp_proxy (which forwards only an allow-listed header set and would
 * otherwise strip the metadata, leaving the backend with an empty idempotency key):
 * - `idempotencyKey`: stable per artifact and reused on retry, so a retried
 *   upload overwrites the same stored object instead of creating a duplicate.
 * - `capturedAtMs`: the capture time in epoch milliseconds, stamped once at
 *   capture and resent unchanged on retry (it is part of the stored object key).
 *
 * @param {object} options - Upload options
 * @param {string} options.filePath - Path to the screenshot file
 * @param {string} options.traceId - Test trace id used as the screenshot key
 * @param {string} options.idempotencyKey - Stable per-artifact key, reused on retry
 * @param {number} options.capturedAtMs - Capture time in epoch milliseconds
 * @param {URL} options.url - The base URL for the screenshot upload
 * @param {boolean} [options.isEvpProxy] - Whether to upload through the Agent's evp_proxy
 * @param {string} [options.evpProxyPrefix] - The evp_proxy path prefix (e.g. '/evp_proxy/v4')
 * @param {Function} callback - Callback function (err)
 */
function uploadTestScreenshot (
  { filePath, traceId, idempotencyKey, capturedAtMs, url, isEvpProxy, evpProxyPrefix },
  callback
) {
  const { DD_API_KEY } = getConfig()

  if (!isValidTraceId(traceId)) {
    return callback(new Error('A non-zero decimal uint64 trace_id is required for test screenshot upload'))
  }
  if (!DD_API_KEY && !isEvpProxy) {
    return callback(new Error('DD_API_KEY is required for test screenshot upload'))
  }
  if (!idempotencyKey) {
    return callback(new Error('An idempotency key is required for test screenshot upload'))
  }
  if (!Number.isInteger(capturedAtMs) || capturedAtMs <= 0) {
    return callback(new Error('A positive captured-at timestamp (epoch ms) is required for test screenshot upload'))
  }

  let screenshotContent
  try {
    screenshotContent = readFileSync(filePath)
  } catch (err) {
    return callback(new Error(`Failed to read screenshot at ${filePath}: ${err.message}`))
  }
  if (screenshotContent.length === 0) {
    return callback(new Error(`Screenshot at ${filePath} is empty`))
  }

  // Metadata rides the query string, not X-Dd-* headers: the Agent's evp_proxy strips
  // non-allow-listed headers, so header-borne metadata reached the backend empty. The key is
  // rendered proxy-safe (see toIdempotencyQueryValue) because evp_proxy also validates the
  // forwarded query against a restrictive charset. capturedAtMs is a plain integer and part of the
  // stored object key, so it (and the key) must stay stable across retries.
  const query = new URLSearchParams({
    idempotency_key: toIdempotencyQueryValue(idempotencyKey),
    captured_at_ms: String(capturedAtMs),
  }).toString()
  const basePath = `${TEST_SCREENSHOT_ENDPOINT_PREFIX}${traceId}${TEST_SCREENSHOT_ENDPOINT_SUFFIX}`

  const contentType = getContentType(filePath)
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
    },
    path: `${basePath}?${query}`,
    timeout: UPLOAD_TIMEOUT_MS,
    url,
  }

  if (isEvpProxy) {
    // Agent mode: prefix the evp_proxy path, tell the proxy which subdomain to forward to, and
    // drop the API key — the Agent injects it. The query params survive the proxy.
    options.path = `${evpProxyPrefix}${basePath}?${query}`
    options.headers['X-Datadog-EVP-Subdomain'] = 'api'
  } else {
    options.headers['DD-API-KEY'] = DD_API_KEY
  }

  log.debug('Uploading test screenshot %s to %s', filePath, new URL(options.path, url).href)

  request(screenshotContent, options, (err, res, statusCode) => {
    if (err) {
      log.error('Error uploading test screenshot: %s', err.message)
      return callback(err)
    }
    log.debug('Test screenshot uploaded successfully (status: %d)', statusCode)
    callback(null)
  })
}

module.exports = { TEST_SCREENSHOT_ENDPOINT_PREFIX, TEST_SCREENSHOT_ENDPOINT_SUFFIX, uploadTestScreenshot }
