'use strict'

const { readFileSync } = require('node:fs')
const { gzipSync } = require('node:zlib')

const FormData = require('../../exporters/common/form-data')
const request = require('../../exporters/common/request')
const log = require('../../log')
const { getValueFromEnvSources } = require('../../config/helper')

const UPLOAD_TIMEOUT_MS = 30_000

/**
 * Uploads coverage reports to the Datadog CI intake.
 * Supports batching up to 10 reports per request with field names 'coverage1', 'event1', 'coverage2', 'event2', etc.
 * @param {object} options - Upload options
 * @param {Array<{filePath: string, format: string}>} options.reports - Array of coverage reports to upload (max 10)
 * @param {object} options.testEnvironmentMetadata - Test environment metadata containing git/CI tags
 * @param {URL} options.url - The base URL for the coverage report upload
 * @param {boolean} [options.isEvpProxy] - Whether to use EVP proxy for the upload
 * @param {string} [options.evpProxyPrefix] - The EVP proxy prefix (e.g., '/evp_proxy/v4')
 * @param {Function} callback - Callback function (err)
 */
function uploadCoverageReport (
  { reports, testEnvironmentMetadata, url, isEvpProxy, evpProxyPrefix },
  callback
) {
  const apiKey = getValueFromEnvSources('DD_API_KEY')

  if (!apiKey && !isEvpProxy) {
    return callback(new Error('DD_API_KEY is required for coverage report upload'))
  }

  if (!reports || !Array.isArray(reports) || reports.length === 0) {
    return callback(new Error('At least one coverage report is required'))
  }

  if (reports.length > 10) {
    return callback(new Error(`Cannot upload more than 10 reports per request (got ${reports.length})`))
  }

  // Create multipart form
  const form = new FormData()

  // Add each report to the form with indexed field names
  for (let i = 0; i < reports.length; i++) {
    const { filePath, format } = reports[i]
    const index = i + 1

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

    form.append(`coverage${index}`, compressedCoverage, {
      filename: `coverage${index}.gz`,
      contentType: 'application/gzip',
    })

    form.append(`event${index}`, JSON.stringify(eventPayload), {
      filename: `event${index}.json`,
      contentType: 'application/json',
    })
  }

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

  log.debug('Uploading %d coverage report(s) to %s%s', reports.length, url, options.path)

  request(form, options, (err, res, statusCode) => {
    if (err) {
      log.error('Error uploading coverage reports: %s', err.message)
      return callback(err)
    }
    log.debug('%d coverage report(s) uploaded successfully (status: %d)', reports.length, statusCode)
    callback(null)
  })
}

module.exports = { uploadCoverageReport }
