'use strict'

const { readFileSync, existsSync } = require('node:fs')
const path = require('node:path')

const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const log = require('../../dd-trace/src/log')
const { discoverCoverageReports } = require('../../dd-trace/src/ci-visibility/coverage-report-discovery')
const { getCacheFolderPath } = require('../../dd-trace/src/ci-visibility/test-optimization-cache')

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

    this.addSub('ci:nyc:report', ({ rootDir, onDone }) => {
      this.#handleCoverageReport(rootDir, onDone)
    })
  }

  /**
   * Reads the library configuration from the test optimization cache folder.
   * @returns {object|undefined} The library configuration settings, or undefined if not available.
   */
  #readLibraryConfiguration () {
    const cacheFolder = getCacheFolderPath()
    if (!cacheFolder) {
      log.debug('Test optimization cache folder not found')
      return
    }

    const configPath = path.join(cacheFolder, 'library-configuration.json')
    if (!existsSync(configPath)) {
      log.debug('Library configuration file not found at %s', configPath)
      return
    }

    try {
      const content = readFileSync(configPath, 'utf8')
      return JSON.parse(content)
    } catch (err) {
      log.debug('Failed to read library configuration: %s', err.message)
    }
  }

  /**
   * Reads the test environment metadata from the test optimization cache folder.
   * @returns {object|undefined} The test environment metadata, or undefined if not available.
   */
  #readTestEnvironmentMetadata () {
    const cacheFolder = getCacheFolderPath()
    if (!cacheFolder) {
      return
    }

    const metadataPath = path.join(cacheFolder, 'test-environment-data.json')
    if (!existsSync(metadataPath)) {
      log.debug('Test environment metadata file not found at %s', metadataPath)
      return
    }

    try {
      const content = readFileSync(metadataPath, 'utf8')
      return JSON.parse(content)
    } catch (err) {
      log.debug('Failed to read test environment metadata: %s', err.message)
    }
  }

  /**
   * Handles the coverage report by discovering and uploading it if enabled.
   * @param {string} rootDir - The root directory where coverage reports are located.
   * @param {Function} [onDone] - Callback to signal completion.
   */
  #handleCoverageReport (rootDir, onDone) {
    const done = onDone || (() => {})

    // Check if the exporter supports coverage report upload
    if (!this.tracer._exporter?.uploadCoverageReport) {
      log.debug('Exporter does not support coverage report upload')
      done()
      return
    }

    const libraryConfig = this.#readLibraryConfiguration()
    const testEnvironmentMetadata = this.#readTestEnvironmentMetadata()

    if (!libraryConfig || !testEnvironmentMetadata) {
      log.debug('Missing library configuration or test environment metadata from cache folder')
      done()
      return
    }

    if (!libraryConfig.isCoverageReportUploadEnabled) {
      log.debug('Coverage report upload is not enabled')
      done()
      return
    }

    const coverageReports = discoverCoverageReports(rootDir)
    if (coverageReports.length === 0) {
      log.debug('No coverage reports found to upload')
      done()
      return
    }

    log.debug('Coverage report upload is enabled, found %d report(s) to upload', coverageReports.length)

    // Upload reports sequentially (one file per request)
    let uploadedCount = 0
    let failedCount = 0
    let reportIndex = 0

    const uploadNextReport = () => {
      if (reportIndex >= coverageReports.length) {
        // All reports processed, log summary
        if (failedCount > 0) {
          log.warn('Coverage report upload completed: %d succeeded, %d failed', uploadedCount, failedCount)
        } else {
          log.info('Coverage report upload completed: %d report(s) uploaded', uploadedCount)
        }
        done()
        return
      }

      const { filePath, format } = coverageReports[reportIndex]
      reportIndex++

      this.tracer._exporter.uploadCoverageReport(
        { filePath, format, testEnvironmentMetadata },
        (err) => {
          if (err) {
            failedCount++
            log.error('Failed to upload coverage report %s: %s', filePath, err.message)
          } else {
            uploadedCount++
          }

          // Process next report
          uploadNextReport()
        }
      )
    }

    uploadNextReport()
  }
}

module.exports = NycPlugin
