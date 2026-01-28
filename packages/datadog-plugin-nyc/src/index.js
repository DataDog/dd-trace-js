'use strict'

const { readFileSync, existsSync } = require('node:fs')
const path = require('node:path')

const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const log = require('../../dd-trace/src/log')
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
   * Handles the coverage report by discovering and uploading it if enabled.
   * @param {string} rootDir - The root directory where coverage reports are located.
   * @param {Function} [onDone] - Callback to signal completion.
   */
  #handleCoverageReport (rootDir, onDone) {
    const done = onDone || (() => {})

    const libraryConfig = this.#readLibraryConfiguration()
    if (!libraryConfig) {
      log.debug('Library configuration not found in cache folder')
      done()
      return
    }

    this.uploadCoverageReports({
      rootDir,
      isCoverageReportUploadEnabled: libraryConfig.isCoverageReportUploadEnabled,
      testEnvironmentMetadata: this.testEnvironmentMetadata,
      onDone: done
    })
  }
}

module.exports = NycPlugin
