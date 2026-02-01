'use strict'

const { readFileSync } = require('node:fs')
const { gzipSync } = require('node:zlib')

const FormData = require('../../exporters/common/form-data')
const request = require('../../exporters/common/request')
const log = require('../../log')
const { getValueFromEnvSources } = require('../../config/helper')

const UPLOAD_TIMEOUT_MS = 30_000

/**
 * Uploads a single coverage report to the Datadog CI intake.
 * One file per request with field names 'coverage' and 'event'.
 * @param {object} options - Upload options
 * @param {string} options.filePath - Path to the coverage report file
 * @param {string} options.format - Format of the coverage report (e.g., 'lcov', 'cobertura')
 * @param {object} options.testEnvironmentMetadata - Test environment metadata containing git/CI tags
 * @param {URL} options.url - The base URL for the coverage report upload
 * @param {boolean} [options.isEvpProxy] - Whether to use EVP proxy for the upload
 * @param {string} [options.evpProxyPrefix] - The EVP proxy prefix (e.g., '/evp_proxy/v4')
 * @param {Function} callback - Callback function (err)
 */
function uploadCoverageReport (
  { filePath, format, testEnvironmentMetadata, url, isEvpProxy, evpProxyPrefix },
  callback
) {
  const apiKey = getValueFromEnvSources('DD_API_KEY')

  if (!apiKey && !isEvpProxy) {
    return callback(new Error('DD_API_KEY is required for coverage report upload'))
  }

  let compressedCoverage
  try {
    const coverageContent = readFileSync(filePath)
    compressedCoverage = gzipSync(coverageContent)
  } catch (err) {
    return callback(new Error(`Failed to read coverage report at ${filePath}: ${err.message}`))
  }

  // Build the event payload with format, type, and all tags from test environment metadata
  const eventPayload = {
    type: 'coverage_report',
    format,
    ...testEnvironmentMetadata,
  }

  // Create multipart form
  const form = new FormData()

  form.append('coverage', compressedCoverage, {
    filename: 'coverage.gz',
    contentType: 'application/gzip',
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
    options.path = `${evpProxyPrefix}/api/v2/cicovreprt`
    options.headers['X-Datadog-EVP-Subdomain'] = 'ci-intake'
  } else {
    options.path = '/api/v2/cicovreprt'
    options.headers['dd-api-key'] = apiKey
  }

  log.debug('Uploading coverage report %s to %s%s', filePath, url, options.path)

  request(form, options, (err, res, statusCode) => {
    if (err) {
      log.error('Error uploading coverage report: %s', err.message)
      return callback(err)
    }
    log.debug('Coverage report uploaded successfully (status: %d)', statusCode)
    callback(null)
  })
}

module.exports = { uploadCoverageReport }
