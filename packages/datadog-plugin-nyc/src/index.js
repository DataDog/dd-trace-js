'use strict'

const { readFileSync, existsSync } = require('node:fs')

const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const log = require('../../dd-trace/src/log')
const { getSettingsCachePath } = require('../../dd-trace/src/ci-visibility/test-optimization-cache')

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
      this.handleCoverageReport(rootDir, onDone)
    })
  }

  /**
   * Reads the library configuration from the settings cache file.
   * @returns {object|undefined} The library configuration settings, or undefined if not available.
   */
  readLibraryConfiguration () {
    const settingsCachePath = getSettingsCachePath()
    if (!settingsCachePath) {
      log.debug('Settings cache path not set (DD_EXPERIMENTAL_TEST_OPT_SETTINGS_CACHE)')
      return
    }

    if (!existsSync(settingsCachePath)) {
      log.debug('Settings cache file not found at %s', settingsCachePath)
      return
    }

    try {
      const content = readFileSync(settingsCachePath, 'utf8')
      return JSON.parse(content)
    } catch (err) {
      log.debug('Failed to read settings cache: %s', err.message)
    }
  }

  /**
   * Handles the coverage report by discovering and uploading it if enabled.
   * @param {string} rootDir - The root directory where coverage reports are located.
   * @param {Function} [onDone] - Callback to signal completion.
   */
  handleCoverageReport (rootDir, onDone) {
    const done = onDone || (() => {})

    const libraryConfig = this.readLibraryConfiguration()
    if (!libraryConfig) {
      log.debug('Library configuration not found in settings cache')
      done()
      return
    }

    if (!libraryConfig.isCoverageReportUploadEnabled) {
      log.debug('Coverage report upload is not enabled')
      done()
      return
    }

    this.uploadCoverageReports({
      rootDir,
      testEnvironmentMetadata: this.testEnvironmentMetadata,
      onDone: done,
    })
  }
}

module.exports = NycPlugin
