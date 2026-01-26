'use strict'

const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const { discoverCoverageReports } = require('../../dd-trace/src/ci-visibility/coverage-report-discovery')
const CoverageReportWriter = require('../../dd-trace/src/ci-visibility/exporters/agentless/coverage-report-writer')
const log = require('../../dd-trace/src/log')
const { getEnvironmentVariable } = require('../../dd-trace/src/config-helper')

class NycPlugin extends CiPlugin {
  static id = 'nyc'

  constructor (...args) {
    super(...args)

    this.addSub('ci:nyc:wrap', (nyc) => {
      if (nyc?.config?.all) {
        this.nyc = nyc
      }
    })

    this.addSub('ci:nyc:get-coverage', ({ onDone }) => {
      if (this.nyc?.getCoverageMapFromAllCoverageFiles) {
        this.nyc.getCoverageMapFromAllCoverageFiles()
          .then((untestedCoverageMap) => {
            this.nyc = null
            onDone(untestedCoverageMap)
          }).catch((e) => {
            this.nyc = null
            onDone()
          })
      } else {
        this.nyc = null
        onDone()
      }
    })

    this.addSub('ci:nyc:report:finish', ({ reportDirectory, cwd, error }) => {
      const fs = require('fs')

      log.debug(() => `NYC plugin: Received report finish event: ${reportDirectory}`)

      // NYC runs in the parent process, separate from the test process
      // Check if CI visibility is enabled and coverage report upload is not explicitly disabled
      const isCiVisibilityEnabled = getEnvironmentVariable('DD_CIVISIBILITY_AGENTLESS_ENABLED') === '1' ||
                                    getEnvironmentVariable('DD_CIVISIBILITY_AGENTLESS_ENABLED') === 'true'
      const isCoverageReportUploadDisabled = getEnvironmentVariable('DD_CIVISIBILITY_CODE_COVERAGE_REPORT_UPLOAD_ENABLED') === 'false' ||
                                              getEnvironmentVariable('DD_CIVISIBILITY_CODE_COVERAGE_REPORT_UPLOAD_ENABLED') === '0'

      const shouldUpload = isCiVisibilityEnabled && !isCoverageReportUploadDisabled

      // Only upload if coverage report upload is enabled
      if (!shouldUpload) {
        log.debug('NYC plugin: Coverage report upload not enabled')
        return
      }

      if (error) {
        log.warn(() => `NYC report generation failed: ${error.message}`)
        // Still try to upload any reports that were generated
      }

      // Use reportDirectory if available, otherwise fall back to cwd/coverage
      const searchDir = reportDirectory || (cwd ? `${cwd}/coverage` : process.cwd())

      log.debug(() => `NYC plugin: Searching for coverage reports in: ${searchDir}`)

      const reports = discoverCoverageReports(searchDir)

      if (!reports || reports.length === 0) {
        log.debug(() => 'No coverage reports found after NYC report generation')
        return
      }

      // Get exporter configuration
      if (!this.tracer?._exporter) {
        log.warn('Tracer exporter not available, cannot upload coverage reports')
        return
      }

      const url = this.tracer._exporter._url
      const evpProxyPrefix = this.tracer._exporter._evpProxyPrefix

      if (!this.testEnvironmentMetadata) {
        log.warn('Test environment metadata not available, cannot upload coverage reports')
        return
      }

      const writer = new CoverageReportWriter({
        url,
        evpProxyPrefix,
        tags: this.testEnvironmentMetadata
      })
      log.debug(() => `Uploading ${reports.length} coverage report(s) from NYC`)

      // Fire-and-forget upload
      try {
        writer.uploadCoverageReports(reports, (err) => {
          if (err) {
            log.error(() => `Failed to upload coverage reports: ${err.message}`)
          } else {
            fs.appendFileSync('/tmp/nyc-debug.log', `[${new Date().toISOString()}] NYC plugin: Upload successful\n`)
            log.debug('Coverage reports uploaded successfully')
          }
        })
      } catch {}
    })
  }
}

module.exports = NycPlugin
