'use strict'

const { execFileSync } = require('node:child_process')

const CiPlugin = require('../../dd-trace/src/plugins/ci_plugin')
const log = require('../../dd-trace/src/log')
const { getValueFromEnvSources } = require('../../dd-trace/src/config/helper')
const { discoverCoverageReports } = require('../../dd-trace/src/ci-visibility/coverage-report-discovery')
const { readSettingsFromCache } = require('../../dd-trace/src/ci-visibility/requests/settings-cache')
const { getRepositoryUrl } = require('../../dd-trace/src/plugins/util/git')
const { getCIMetadata } = require('../../dd-trace/src/plugins/util/ci')
const { filterSensitiveInfoFromRepository } = require('../../dd-trace/src/plugins/util/url')

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

    this.addSub('ci:nyc:report', ({ rootDir }) => {
      this.#handleCoverageReport(rootDir)
    })
  }

  /**
   * Gets the repository URL and commit SHA from environment or git commands.
   * Uses the same sources as the main tracer to ensure cache key consistency.
   * @returns {{repositoryUrl: string|undefined, sha: string|undefined}}
   */
  #getGitInfo () {
    // Check user-provided env vars first (same as main tracer)
    let repositoryUrl = getValueFromEnvSources('DD_GIT_REPOSITORY_URL')
    let sha = getValueFromEnvSources('DD_GIT_COMMIT_SHA')

    // Fall back to CI metadata
    if (!repositoryUrl || !sha) {
      const ciMetadata = getCIMetadata()
      repositoryUrl = repositoryUrl || ciMetadata['git.repository_url']
      sha = sha || ciMetadata['git.commit.sha']
    }

    // Fall back to git commands if still not available
    if (!repositoryUrl) {
      const rawRepositoryUrl = getRepositoryUrl()
      repositoryUrl = filterSensitiveInfoFromRepository(rawRepositoryUrl) || rawRepositoryUrl
    }
    if (!sha) {
      try {
        sha = execFileSync('git', ['rev-parse', 'HEAD'], { stdio: 'pipe' }).toString().trim()
      } catch {
        // Git command failed
      }
    }

    // Apply filtering to match main tracer behavior
    if (repositoryUrl) {
      const filteredUrl = filterSensitiveInfoFromRepository(repositoryUrl)
      if (filteredUrl) {
        repositoryUrl = filteredUrl
      }
    }

    return { repositoryUrl, sha }
  }

  /**
   * Handles the coverage report by discovering and uploading it if enabled.
   * @param {string} rootDir - The root directory where coverage reports are located.
   */
  #handleCoverageReport (rootDir) {
    const { repositoryUrl, sha } = this.#getGitInfo()

    if (!repositoryUrl || !sha) {
      log.debug('Could not determine repository URL or commit SHA for settings cache lookup')
      return
    }

    const settings = readSettingsFromCache(sha, repositoryUrl)
    if (!settings?.isCoverageReportUploadEnabled) {
      log.debug('Coverage report upload is not enabled')
      return
    }

    const coverageReports = discoverCoverageReports(rootDir)
    if (coverageReports.length === 0) {
      log.debug('No coverage reports found to upload')
      return
    }

    // TODO: Upload the code coverage reports
    log.debug('Coverage report upload is enabled, found %d report(s) to upload', coverageReports.length)

    // eslint-disable-next-line no-console
    console.log(`[dd-trace] Uploading ${coverageReports.length} coverage report(s)`)
  }
}

module.exports = NycPlugin
