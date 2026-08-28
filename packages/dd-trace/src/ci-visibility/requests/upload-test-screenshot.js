'use strict'

const { createReadStream, statSync } = require('node:fs')
const { extname } = require('node:path')

const getConfig = require('../../config')
const { EVP_SUBDOMAIN_HEADER_NAME } = require('../../evp_proxy/constants')
const { joinEVPProxyPath } = require('../../evp_proxy/path')
const log = require('../../log')
const { getAgent } = require('../exporters/agents')
const request = require('../exporters/request')

const UPLOAD_TIMEOUT_MS = 30_000
const TEST_RUN_MEDIA_ENDPOINT_PREFIX = '/api/v2/ci/test-runs/'
const TEST_SUITE_MEDIA_ENDPOINT_PREFIX = '/api/v2/ci/test-suites/'
const MEDIA_ENDPOINT_SUFFIX = '/media'
const MAX_VIDEO_SIZE_BYTES = 200 * 1024 * 1024
const UINT64_MAX = 18_446_744_073_709_551_615n

function getContentType (filePath, kind) {
  const extension = extname(filePath).toLowerCase()
  if (kind === 'video') {
    return extension === '.mp4' ? 'video/mp4' : 'video/webm'
  }
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

function isValidId (value) {
  if (!/^[1-9]\d*$/.test(value)) {
    return false
  }
  return BigInt(value) <= UINT64_MAX
}

/**
 * Renders an idempotency key into a value safe to carry in the upload's query string.
 *
 * @param {string} idempotencyKey - Raw per-artifact idempotency key
 * @returns {string} Query-safe, deterministic representation of the key
 */
function toIdempotencyQueryValue (idempotencyKey) {
  const separatorIndex = idempotencyKey.indexOf(':')
  if (separatorIndex === -1) {
    return Buffer.from(idempotencyKey, 'utf8').toString('hex')
  }
  const idPart = idempotencyKey.slice(0, separatorIndex)
  const artifactPart = idempotencyKey.slice(separatorIndex + 1)
  return `${idPart}:${Buffer.from(artifactPart, 'utf8').toString('hex')}`
}

/**
 * Uploads one screenshot or video to the Test Optimization media intake.
 *
 * @param {object} options - Upload options
 * @param {string} options.filePath - Path to the media file
 * @param {'screenshot'|'video'} options.kind - Media kind
 * @param {string} [options.traceId] - Test trace id for test-scoped media
 * @param {string} [options.testSessionId] - Test session id for suite-scoped media
 * @param {string} [options.testSuiteId] - Test suite id for suite-scoped media
 * @param {string} options.idempotencyKey - Stable per-artifact key, reused on retry
 * @param {number} options.capturedAtMs - Capture time in epoch milliseconds
 * @param {URL} options.url - Base URL for the media upload
 * @param {boolean} [options.isEvpProxy] - Whether to upload through the Agent's evp_proxy
 * @param {string} [options.evpProxyPrefix] - evp_proxy path prefix
 * @param {number} [options.deadline] - Absolute finalization deadline in epoch milliseconds
 * @param {AbortSignal} [options.signal] - Signal used to cancel the upload
 * @param {Function} callback - Callback function (err)
 * @returns {void}
 */
function uploadTestMedia (options, callback) {
  const {
    filePath,
    kind,
    traceId,
    testSessionId,
    testSuiteId,
    idempotencyKey,
    capturedAtMs,
    url,
    isEvpProxy,
    evpProxyPrefix,
    deadline,
    signal,
  } = options
  const { DD_API_KEY } = getConfig()
  const isSuiteScoped = testSessionId !== undefined || testSuiteId !== undefined
  let basePath

  if (kind !== 'screenshot' && kind !== 'video') {
    return callback(new Error('A supported media kind is required for test media upload'))
  }
  if (isSuiteScoped) {
    if (!isValidId(testSessionId) || !isValidId(testSuiteId)) {
      return callback(new Error(
        'Non-zero decimal uint64 test_session_id and test_suite_id are required for test suite media upload'
      ))
    }
    basePath = `${TEST_SUITE_MEDIA_ENDPOINT_PREFIX}${testSessionId}/${testSuiteId}${MEDIA_ENDPOINT_SUFFIX}`
  } else {
    if (!isValidId(traceId)) {
      return callback(new Error('A non-zero decimal uint64 trace_id is required for test media upload'))
    }
    basePath = `${TEST_RUN_MEDIA_ENDPOINT_PREFIX}${traceId}${MEDIA_ENDPOINT_SUFFIX}`
  }
  if (!DD_API_KEY && !isEvpProxy) {
    return callback(new Error('DD_API_KEY is required for test media upload'))
  }
  if (!idempotencyKey) {
    return callback(new Error('An idempotency key is required for test media upload'))
  }
  if (!Number.isInteger(capturedAtMs) || capturedAtMs <= 0) {
    return callback(new Error('A positive captured-at timestamp (epoch ms) is required for test media upload'))
  }

  let fileSize
  try {
    fileSize = statSync(filePath).size
  } catch (error) {
    return callback(new Error(`Failed to inspect ${kind} at ${filePath}: ${error.message}`))
  }
  if (fileSize === 0) {
    return callback(new Error(`${kind === 'video' ? 'Video' : 'Screenshot'} at ${filePath} is empty`))
  }
  if (kind === 'video' && fileSize > MAX_VIDEO_SIZE_BYTES) {
    const error = new Error(
      `Video at ${filePath} is ${fileSize} bytes and exceeds the ${MAX_VIDEO_SIZE_BYTES}-byte upload limit`
    )
    log.warn('Skipping test video upload: %s', error.message)
    return callback(error)
  }

  // Metadata must use query params because the Agent's evp_proxy strips non-allow-listed headers.
  const query = new URLSearchParams({
    idempotency_key: toIdempotencyQueryValue(idempotencyKey),
    captured_at_ms: String(capturedAtMs),
  }).toString()
  const contentType = getContentType(filePath, kind)
  const requestOptions = {
    method: 'POST',
    headers: {
      'Content-Length': fileSize,
      'Content-Type': contentType,
    },
    path: `${basePath}?${query}`,
    timeout: UPLOAD_TIMEOUT_MS,
    url,
    agent: getAgent(url),
    deadline,
    retryUntilDeadline: false,
    signal,
  }

  if (isEvpProxy) {
    requestOptions.path = `${joinEVPProxyPath(evpProxyPrefix, basePath)}?${query}`
    requestOptions.headers[EVP_SUBDOMAIN_HEADER_NAME] = 'api'
  } else {
    requestOptions.headers['DD-API-KEY'] = DD_API_KEY
  }

  log.debug('Uploading test %s %s to %s', kind, filePath, new URL(requestOptions.path, url).href)

  // The retry layer invokes this factory for every attempt, so uploads stay replayable without
  // buffering the complete media file in the application process.
  request(() => createReadStream(filePath), requestOptions, (error, response, statusCode) => {
    if (error) {
      log.error('Error uploading test %s: %s', kind, error.message)
      return callback(error)
    }
    if (statusCode === undefined) {
      const uploadError = new Error(`Test ${kind} upload request was dropped before it was sent`)
      log.error('Error uploading test %s: %s', kind, uploadError.message)
      return callback(uploadError)
    }
    log.debug('Test %s uploaded successfully (status: %d)', kind, statusCode)
    callback(null)
  })
}

/**
 * Uploads a test-scoped failure screenshot.
 *
 * @param {object} options - Upload options
 * @param {Function} callback - Callback function (err)
 * @returns {void}
 */
function uploadTestScreenshot (options, callback) {
  uploadTestMedia({ ...options, kind: 'screenshot' }, callback)
}

/**
 * Uploads a test-scoped failure video.
 *
 * @param {object} options - Upload options
 * @param {Function} callback - Callback function (err)
 * @returns {void}
 */
function uploadTestVideo (options, callback) {
  uploadTestMedia({ ...options, kind: 'video' }, callback)
}

/**
 * Uploads a suite-scoped failure video.
 *
 * @param {object} options - Upload options
 * @param {Function} callback - Callback function (err)
 * @returns {void}
 */
function uploadTestSuiteVideo (options, callback) {
  uploadTestMedia({ ...options, kind: 'video' }, callback)
}

module.exports = {
  MAX_VIDEO_SIZE_BYTES,
  MEDIA_ENDPOINT_SUFFIX,
  TEST_RUN_MEDIA_ENDPOINT_PREFIX,
  TEST_SUITE_MEDIA_ENDPOINT_PREFIX,
  uploadTestScreenshot,
  uploadTestSuiteVideo,
  uploadTestVideo,
}
