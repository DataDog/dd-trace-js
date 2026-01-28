'use strict'

const shimmer = require('../../datadog-shimmer')
const { getEnvironmentVariable } = require('../../dd-trace/src/config/helper')
const { createCacheFolderIfNeeded } = require('../../dd-trace/src/ci-visibility/test-optimization-cache')
const { addHook, channel } = require('./helpers/instrument')

const codeCoverageWrapCh = channel('ci:nyc:wrap')
const codeCoverageReportCh = channel('ci:nyc:report')

addHook({
  name: 'nyc',
  versions: ['>=17']
}, (nycPackage) => {
  // `wrap` is an async function
  shimmer.wrap(nycPackage.prototype, 'wrap', wrap => function () {
    // Set up the cache folder for test optimization data sharing (needed for coverage report upload)
    createCacheFolderIfNeeded()

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
    const nycInstance = this
    const reportPromise = report.apply(this, arguments)

    if (codeCoverageReportCh.hasSubscribers && reportPromise && typeof reportPromise.then === 'function') {
      // Return a new promise that waits for both the report AND the coverage upload
      return reportPromise.then(() => {
        return new Promise((resolve) => {
          codeCoverageReportCh.publish({
            rootDir: nycInstance.cwd,
            onDone: resolve
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
