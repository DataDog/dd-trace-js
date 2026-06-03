'use strict'

const shimmer = require('../../datadog-shimmer')
const { getEnvironmentVariable } = require('../../dd-trace/src/config/helper')
const {
  readCoverageBackfillFromCache,
  readCoverageBackfillRootDirFromCache,
  setupSettingsCachePath,
} = require('../../dd-trace/src/ci-visibility/test-optimization-cache')
const { applySkippedCoverageToCoverage } = require('../../dd-trace/src/plugins/util/test')
const { addHook, channel } = require('./helpers/instrument')

const codeCoverageWrapCh = channel('ci:nyc:wrap')
const codeCoverageReportCh = channel('ci:nyc:report')

addHook({
  name: 'nyc',
  versions: ['>=17'],
}, (nycPackage) => {
  // Set up the cache file path early (when nyc is required) so it's available
  // when dd-trace fetches library configuration
  setupSettingsCachePath()

  if (nycPackage.prototype.getCoverageMapFromAllCoverageFiles) {
    // Some test frameworks receive skipped-suite coverage in the test process, but nyc merges reports later in the nyc
    // process. Reuse the settings cache path as the process handoff so nyc can backfill skipped files before reporting.
    shimmer.wrap(
      nycPackage.prototype,
      'getCoverageMapFromAllCoverageFiles',
      getCoverageMapFromAllCoverageFiles => function (...args) {
        const coverageMap = getCoverageMapFromAllCoverageFiles.apply(this, args)
        const applyCoverageBackfill = (resolvedCoverageMap) => {
          try {
            if (!resolvedCoverageMap) {
              return resolvedCoverageMap
            }
            applySkippedCoverageToCoverage(
              resolvedCoverageMap,
              readCoverageBackfillFromCache(),
              readCoverageBackfillRootDirFromCache() || this.cwd
            )
          } catch {
            // Do not break nyc's report generation if the cached backfill is stale or malformed.
          }
          return resolvedCoverageMap
        }

        if (coverageMap && typeof coverageMap.then === 'function') {
          return coverageMap.then(applyCoverageBackfill)
        }
        return applyCoverageBackfill(coverageMap)
      }
    )
  }

  // `wrap` is an async function
  shimmer.wrap(nycPackage.prototype, 'wrap', wrap => function (...args) {
    // Only relevant if the config `all` is set to true (for untested code coverage)
    try {
      if (JSON.parse(getEnvironmentVariable('NYC_CONFIG')).all) {
        codeCoverageWrapCh.publish(this)
      }
    } catch {
      // ignore errors
    }

    return wrap.apply(this, args)
  })

  // `report` is an async function, so we wait for it to complete before publishing
  shimmer.wrap(nycPackage.prototype, 'report', report => function (...args) {
    if (!codeCoverageReportCh.hasSubscribers) {
      return report.apply(this, args)
    }
    const nycInstance = this
    const reportPromise = report.apply(this, args)

    if (reportPromise && typeof reportPromise.then === 'function') {
      // Return a new promise that waits for both the report AND the coverage upload
      return reportPromise.then(() => {
        return new Promise((resolve) => {
          codeCoverageReportCh.publish({
            rootDir: nycInstance.cwd,
            onDone: resolve,
          })
        })
      }).catch(() => {
        // Ignore errors - report generation failed
      })
    }

    return reportPromise
  })

  return nycPackage
})
