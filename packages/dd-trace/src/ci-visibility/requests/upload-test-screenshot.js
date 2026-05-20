'use strict'

const { readFileSync } = require('node:fs')
const { extname } = require('node:path')

const getConfig = require('../../config')
const FormData = require('../../exporters/common/form-data')
const request = require('../../exporters/common/request')
const log = require('../../log')

const UPLOAD_TIMEOUT_MS = 30_000
const TEST_SCREENSHOT_ENDPOINT = '/api/v2/ci/tests/screenshots'

function getContentType (filePath) {
  const extension = extname(filePath).toLowerCase()
  if (extension === '.jpg' || extension === '.jpeg') {
    return 'image/jpeg'
  }
  if (extension === '.webp') {
    return 'image/webp'
  }
  return 'image/png'
}

/**
 * Uploads a single test screenshot to the Datadog CI intake.
 * One file per request with field names 'screenshot' and 'event'.
 *
 * @param {object} options - Upload options
 * @param {string} options.filePath - Path to the screenshot file
 * @param {string} options.traceId - Test trace id used as the screenshot key
 * @param {string} options.testName - Test name associated with the screenshot
 * @param {string} options.testSuite - Test suite associated with the screenshot
 * @param {object} options.testEnvironmentMetadata - Test environment metadata containing git/CI tags
 * @param {URL} options.url - The base URL for the screenshot upload
 * @param {boolean} [options.isEvpProxy] - Whether to use EVP proxy for the upload
 * @param {string} [options.evpProxyPrefix] - The EVP proxy prefix (e.g., '/evp_proxy/v4')
 * @param {Function} callback - Callback function (err)
 */
function uploadTestScreenshot (
  { filePath, traceId, testName, testSuite, testEnvironmentMetadata, url, isEvpProxy, evpProxyPrefix },
  callback
) {
  const apiKey = getConfig().apiKey

  if (!traceId) {
    return callback(new Error('trace_id is required for test screenshot upload'))
  }
  if (!apiKey && !isEvpProxy) {
    return callback(new Error('DD_API_KEY is required for test screenshot upload'))
  }

  let screenshotContent
  try {
    screenshotContent = readFileSync(filePath)
  } catch (err) {
    return callback(new Error(`Failed to read screenshot at ${filePath}: ${err.message}`))
  }

  const contentType = getContentType(filePath)
  const filename = `${traceId}${extname(filePath) || '.png'}`
  const eventPayload = {
    type: 'test_screenshot',
    trace_id: traceId,
    test_name: testName,
    test_suite: testSuite,
    filename,
    content_type: contentType,
    ...testEnvironmentMetadata,
  }

  const form = new FormData()

  form.append('screenshot', screenshotContent, {
    filename,
    contentType,
  })

  form.append('event', JSON.stringify(eventPayload), {
    filename: 'event.json',
    contentType: 'application/json',
  })

  const options = {
    method: 'POST',
    headers: {
      ...form.getHeaders(),
    },
    timeout: UPLOAD_TIMEOUT_MS,
    url,
  }

  if (isEvpProxy) {
    options.path = `${evpProxyPrefix}${TEST_SCREENSHOT_ENDPOINT}`
    options.headers['X-Datadog-EVP-Subdomain'] = 'ci-intake'
  } else {
    options.path = TEST_SCREENSHOT_ENDPOINT
    options.headers['dd-api-key'] = apiKey
  }

  log.debug('Uploading test screenshot %s to %s%s', filePath, url, options.path)

  request(form, options, (err, res, statusCode) => {
    if (err) {
      log.error('Error uploading test screenshot: %s', err.message)
      return callback(err)
    }
    log.debug('Test screenshot uploaded successfully (status: %d)', statusCode)
    callback(null)
  })
}

module.exports = { TEST_SCREENSHOT_ENDPOINT, uploadTestScreenshot }
