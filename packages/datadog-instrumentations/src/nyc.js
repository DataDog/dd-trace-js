'use strict'

const shimmer = require('../../datadog-shimmer')
const { getEnvironmentVariable } = require('../../dd-trace/src/config-helper')
const log = require('../../dd-trace/src/log')
const { addHook, channel } = require('./helpers/instrument')

const codeCoverageWrapCh = channel('ci:nyc:wrap')
const reportFinishCh = channel('ci:nyc:report:finish')

addHook({
  name: 'nyc',
  versions: ['>=17']
}, (nycPackage) => {
  log.debug('NYC instrumentation: Hooking into NYC package')
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

  // Hook into the report() method to detect when coverage reports are written
  shimmer.wrap(nycPackage.prototype, 'report', report => function () {
    const result = report.apply(this, arguments)

    // report() is an async function, so we need to wait for it to complete
    if (result && typeof result.then === 'function') {
      return result.then((value) => {
        // Publish after reports are written to disk
        const reportDir = this.reportDirectory()
        const cwd = this.cwd
        log.debug(() => `NYC instrumentation: Publishing report finish event: ${reportDir}`)
        reportFinishCh.publish({
          reportDirectory: reportDir,
          cwd
        })
        return value
      }).catch((err) => {
        // Still publish even if report() fails so we don't block
        log.debug(() => `NYC instrumentation: Publishing report finish event (with error): ${err.message}`)
        reportFinishCh.publish({
          reportDirectory: this.reportDirectory(),
          cwd: this.cwd,
          error: err
        })
        throw err
      })
    }

    return result
  })

  return nycPackage
})
