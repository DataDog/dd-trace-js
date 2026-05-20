'use strict'

const { readFileSync } = require('node:fs')
const { extname } = require('node:path')

const getConfig = require('../../config')
const request = require('../../exporters/common/request')
const log = require('../../log')

const UPLOAD_TIMEOUT_MS = 30_000
const TEST_SCREENSHOT_ENDPOINT_PREFIX = '/api/unstable/ci/test-runs/'
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
 * Uploads a single test screenshot to the Datadog CI intake.
 * The trace id is included in the request path and the body is the raw image bytes.
 *
 * @param {object} options - Upload options
 * @param {string} options.filePath - Path to the screenshot file
 * @param {string} options.traceId - Test trace id used as the screenshot key
 * @param {URL} options.url - The base URL for the screenshot upload
 * @param {Function} callback - Callback function (err)
 */
function uploadTestScreenshot (
  { filePath, traceId, url },
  callback
) {
  const apiKey = getConfig().apiKey

  if (!isValidTraceId(traceId)) {
    return callback(new Error('A non-zero decimal uint64 trace_id is required for test screenshot upload'))
  }
  if (!apiKey) {
    return callback(new Error('DD_API_KEY is required for test screenshot upload'))
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

  const options = {
    method: 'POST',
    headers: {
      'Content-Type': getContentType(filePath),
      'DD-API-KEY': apiKey,
    },
    path: `${TEST_SCREENSHOT_ENDPOINT_PREFIX}${traceId}${TEST_SCREENSHOT_ENDPOINT_SUFFIX}`,
    timeout: UPLOAD_TIMEOUT_MS,
    url,
  }

  log.debug('Uploading test screenshot %s to %s%s', filePath, url, options.path)

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
