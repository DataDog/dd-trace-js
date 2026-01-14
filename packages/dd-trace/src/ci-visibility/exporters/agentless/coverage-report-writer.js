'use strict'

const fs = require('node:fs')
const zlib = require('node:zlib')

const request = require('../../../exporters/common/request')
const log = require('../../../log')
const FormData = require('../../../exporters/common/form-data')
const { safeJSONStringify } = require('../../../exporters/common/util')
const { getEnvironmentVariable } = require('../../../config-helper')
const {
  incrementCountMetric,
  distributionMetric,
  TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS,
  TELEMETRY_ENDPOINT_PAYLOAD_BYTES,
  TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_MS,
  TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_ERRORS,
  TELEMETRY_ENDPOINT_PAYLOAD_DROPPED
} = require('../../telemetry')

/**
 * Writer class for uploading code coverage reports to Datadog CI intake
 */
class CoverageReportWriter {
  /**
   * @param {object} options - Configuration options
   * @param {URL} options.url - The CI intake URL
   * @param {string} [options.evpProxyPrefix] - EVP proxy prefix for agent-proxy mode
   * @param {object} options.tags - Git and CI tags for the event payload
   */
  constructor ({ url, evpProxyPrefix = '', tags = {} }) {
    this._url = url
    this._evpProxyPrefix = evpProxyPrefix
    this._tags = tags
  }

  /**
   * Uploads coverage reports to the CI intake endpoint
   *
   * @param {Array<{filePath: string, format: string}>} reports - Array of coverage reports to upload
   * @param {Function} callback - Callback function called when upload completes (or fails)
   */
  uploadCoverageReports (reports, callback) {
    if (!reports || reports.length === 0) {
      log.debug('No coverage reports to upload')
      if (callback) callback()
      return
    }

    log.debug(() => `Uploading ${reports.length} coverage report(s)`)

    const form = new FormData()
    const events = []
    let hasError = false

    // Process each report: read file and compress
    for (let i = 0; i < reports.length; i++) {
      const report = reports[i]
      const coveragePartName = `coverage${i + 1}`

      try {
        // Read coverage report file
        const fileContent = fs.readFileSync(report.filePath)

        // Compress with gzip (level 1 for speed)
        const compressedContent = zlib.gzipSync(fileContent, { level: 1 })

        // Add coverage part to form
        form.append(coveragePartName, compressedContent, {
          filename: `${coveragePartName}.gz`,
          contentType: 'application/gzip'
        })

        // Create event metadata for this report
        const event = {
          type: 'coverage_report',
          format: report.format,
          ...this._tags
        }
        events.push(event)

        log.debug(() =>
          `Added coverage report ${i + 1}: ${report.filePath} (${report.format}, ` +
          `${fileContent.length} bytes, compressed to ${compressedContent.length} bytes)`
        )
      } catch (err) {
        log.error(`Error reading or compressing coverage report ${report.filePath}: ${err.message}`)
        hasError = true
        // Continue with other reports even if one fails
      }
    }

    // If all reports failed, don't send request
    if (events.length === 0) {
      log.error('Failed to process any coverage reports')
      if (callback) callback(new Error('Failed to process any coverage reports'))
      return
    }

    // Add event metadata as JSON array
    form.append('event', JSON.stringify(events), {
      filename: 'event.json',
      contentType: 'application/json'
    })

    // Prepare request options
    const options = {
      path: '/api/v2/cicovreprt',
      method: 'POST',
      headers: {
        ...form.getHeaders()
      },
      timeout: 20_000,
      url: this._url
    }

    // Configure for agentless or agent-proxy mode
    if (this._evpProxyPrefix) {
      options.path = `${this._evpProxyPrefix}/api/v2/cicovreprt`
      options.headers['X-Datadog-EVP-Subdomain'] = 'ci-intake'
    } else {
      const apiKey = getEnvironmentVariable('DD_API_KEY')
      if (!apiKey) {
        log.error('DD_API_KEY not set, cannot upload coverage reports in agentless mode')
        if (callback) callback(new Error('DD_API_KEY not set'))
        return
      }
      options.headers['dd-api-key'] = apiKey
    }

    log.debug(() => `Uploading coverage reports to intake: ${safeJSONStringify(options)}`)

    const startRequestTime = Date.now()
    const payloadSize = form.size()

    // Record telemetry metrics
    incrementCountMetric(TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS, { endpoint: 'coverage_report_upload' })
    distributionMetric(TELEMETRY_ENDPOINT_PAYLOAD_BYTES, { endpoint: 'coverage_report_upload' }, payloadSize)

    // Send request
    request(form, options, (err, res, statusCode) => {
      const requestDuration = Date.now() - startRequestTime

      distributionMetric(
        TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_MS,
        { endpoint: 'coverage_report_upload' },
        requestDuration
      )

      if (err) {
        incrementCountMetric(
          TELEMETRY_ENDPOINT_PAYLOAD_REQUESTS_ERRORS,
          { endpoint: 'coverage_report_upload', statusCode }
        )
        incrementCountMetric(
          TELEMETRY_ENDPOINT_PAYLOAD_DROPPED,
          { endpoint: 'coverage_report_upload' }
        )
        log.error(`Error uploading coverage reports: ${err.message}`)
        if (callback) callback(err)
        return
      }

      log.debug(() => `Coverage reports uploaded successfully (status: ${statusCode}, duration: ${requestDuration}ms)`)
      log.debug(() => `Response from intake: ${res}`)

      if (callback) callback(hasError ? new Error('Some reports failed to process') : null)
    })
  }
}

module.exports = CoverageReportWriter
