'use strict'

const { closeSync, constants, fstatSync, openSync, readFileSync } = require('node:fs')
const { gzipSync } = require('node:zlib')

const getConfig = require('../../config')
const { EVP_SUBDOMAIN_HEADER_NAME } = require('../../evp_proxy/constants')
const { joinEVPProxyPath } = require('../../evp_proxy/path')
const FormData = require('../../exporters/common/form-data')
const request = require('../../exporters/common/request')
const log = require('../../log')
const {
  incrementCountMetric,
  distributionMetric,
  TELEMETRY_COVERAGE_UPLOAD,
  TELEMETRY_COVERAGE_UPLOAD_MS,
  TELEMETRY_COVERAGE_UPLOAD_ERRORS,
  TELEMETRY_COVERAGE_UPLOAD_BYTES,
} = require('../telemetry')

const UPLOAD_TIMEOUT_MS = 30_000
const COVERAGE_FILE_OPEN_FLAGS = constants.O_RDONLY |
  (constants.O_NOFOLLOW || 0) |
  constants.O_NONBLOCK
const BIGINT_STAT_OPTIONS = { bigint: true }

/**
 * Uploads a single coverage report to the Datadog CI intake.
 * One file per request with field names 'coverage' and 'event'.
 * @param {object} options - Upload options
 * @param {string} options.filePath - Path to the coverage report file
 * @param {bigint} options.fileDevice - Device containing the discovered report
 * @param {bigint} options.fileInode - Inode of the discovered report
 * @param {string} options.format - Format of the coverage report (e.g., 'lcov', 'cobertura')
 * @param {string[]} [options.flags] - Optional coverage report grouping flags
 * @param {object} options.testEnvironmentMetadata - Test environment metadata containing git/CI tags
 * @param {URL} options.url - The base URL for the coverage report upload
 * @param {boolean} [options.isEvpProxy] - Whether to use EVP proxy for the upload
 * @param {string} [options.evpProxyPrefix] - The EVP proxy prefix (e.g., '/evp_proxy/v4')
 * @param {(error: Error|null) => void} callback - Callback function
 */
function uploadCoverageReport (
  { filePath, fileDevice, fileInode, format, flags, testEnvironmentMetadata, url, isEvpProxy, evpProxyPrefix },
  callback
) {
  const { DD_API_KEY } = getConfig()

  if (!DD_API_KEY && !isEvpProxy) {
    return callback(new Error('DD_API_KEY is required for coverage report upload'))
  }

  let compressedCoverage
  try {
    const fileDescriptor = openSync(filePath, COVERAGE_FILE_OPEN_FLAGS)
    let coverageContent
    try {
      const fileStats = fstatSync(fileDescriptor, BIGINT_STAT_OPTIONS)
      if (!fileStats.isFile() || fileStats.dev !== fileDevice || fileStats.ino !== fileInode) {
        throw new Error('Coverage report changed after discovery')
      }
      coverageContent = readFileSync(fileDescriptor)
    } finally {
      closeSync(fileDescriptor)
    }
    compressedCoverage = gzipSync(coverageContent)
  } catch (error) {
    return callback(new Error(`Failed to read coverage report at ${filePath}: ${error.message}`))
  }

  // Build the event payload with format, type, and all tags from test environment metadata
  const eventPayload = {
    type: 'coverage_report',
    format,
    ...testEnvironmentMetadata,
  }
  if (flags?.length) {
    eventPayload['report.flags'] = flags
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
    options.path = joinEVPProxyPath(evpProxyPrefix, '/api/v2/cicovreprt')
    options.headers[EVP_SUBDOMAIN_HEADER_NAME] = 'ci-intake'
  } else {
    options.path = '/api/v2/cicovreprt'
    options.headers['dd-api-key'] = DD_API_KEY
  }

  log.debug('Uploading coverage report %s to %s%s', filePath, url, options.path)

  incrementCountMetric(TELEMETRY_COVERAGE_UPLOAD)
  distributionMetric(TELEMETRY_COVERAGE_UPLOAD_BYTES, {}, compressedCoverage.length)

  const startTime = Date.now()

  request(form, options, (err, res, statusCode) => {
    distributionMetric(TELEMETRY_COVERAGE_UPLOAD_MS, {}, Date.now() - startTime)
    if (err) {
      incrementCountMetric(TELEMETRY_COVERAGE_UPLOAD_ERRORS, { statusCode })
      log.error('Error uploading coverage report: %s', err.message)
      return callback(err)
    }
    log.debug('Coverage report uploaded successfully (status: %d)', statusCode)
    callback(null)
  })
}

module.exports = { uploadCoverageReport }
