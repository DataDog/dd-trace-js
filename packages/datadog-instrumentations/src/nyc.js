'use strict'

const shimmer = require('../../datadog-shimmer')
const { getEnvironmentVariable } = require('../../dd-trace/src/config/helper')
const { setupSettingsCachePath } = require('../../dd-trace/src/ci-visibility/test-optimization-cache')
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

  // `wrap` is an async function
  shimmer.wrap(nycPackage.prototype, 'wrap', wrap => function () {
    // Only relevant if the config `all` is set to true (for untested code coverage)
    try {
      if (JSON.parse(getEnvironmentVariable('NYC_CONFIG')).all) {
        codeCoverageWrapCh.publish(this)
      }
    } catch {
      // ignore errors
    }

    return wrap.apply(this, arguments)
  })

  // `report` is an async function, so we wait for it to complete before publishing
  shimmer.wrap(nycPackage.prototype, 'report', report => function () {
    if (!codeCoverageReportCh.hasSubscribers) {
      return report.apply(this, arguments)
    }
    const nycInstance = this
    const reportPromise = report.apply(this, arguments)

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
