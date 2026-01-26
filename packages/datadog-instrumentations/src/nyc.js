'use strict'

const shimmer = require('../../datadog-shimmer')
const { getEnvironmentVariable } = require('../../dd-trace/src/config/helper')
const { addHook, channel } = require('./helpers/instrument')

const codeCoverageWrapCh = channel('ci:nyc:wrap')
const codeCoverageReportCh = channel('ci:nyc:report')

addHook({
  name: 'nyc',
  versions: ['>=17']
}, (nycPackage) => {
  // `wrap` is an async function
  shimmer.wrap(nycPackage.prototype, 'wrap', wrap => function () {
    // Only relevant if the config `all` is set to true
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
      reportPromise.then(() => {
        codeCoverageReportCh.publish({ rootDir: nycInstance.cwd })
      }).catch(() => {
        // Ignore errors - report generation failed
      })
    }

    return reportPromise
  })

  return nycPackage
})
