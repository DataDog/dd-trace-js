'use strict'

const { channel } = require('dc-polyfill')

const reporterErrorCh = channel('ci:playwright:reporter:error')
const PLAYWRIGHT_REPORTER_ERROR_MESSAGE = 'Error in reporter'
const PLAYWRIGHT_REPORTER_ERROR_CALLER_RE =
  /^\s*at wrapAsync .*?[\\/]playwright[\\/]lib[\\/]runner[\\/]index\.js:\d+:\d+\)?$/

/**
 * Identifies the private Playwright 1.60-1.61 reporter error fallback without
 * interpreting identical user console output as a framework error.
 *
 * @param {unknown} message - First console.error argument
 * @returns {boolean}
 */
function isPlaywrightReporterError (message) {
  if (message !== PLAYWRIGHT_REPORTER_ERROR_MESSAGE) return false

  const originalPrepareStackTrace = Error.prepareStackTrace
  try {
    Error.prepareStackTrace = (_, callSites) => callSites
    const stack = new Error('Playwright reporter error provenance').stack
    return PLAYWRIGHT_REPORTER_ERROR_CALLER_RE.test(stack?.[2]?.toString() || '')
  } finally {
    Error.prepareStackTrace = originalPrepareStackTrace
  }
}

class DatadogPlaywrightReporter {
  /**
   * Restores console error after Playwright completes the reporter lifecycle.
   *
   * @returns {void}
   */
  static restoreConsoleError () {
    // eslint-disable-next-line no-console
    if (console.error === DatadogPlaywrightReporter.consoleError) {
      // eslint-disable-next-line no-console
      console.error = DatadogPlaywrightReporter.originalConsoleError
    }
    DatadogPlaywrightReporter.consoleError = undefined
    DatadogPlaywrightReporter.originalConsoleError = undefined
  }

  /**
   * Marks the beginning of reporter finalization so later reporter errors can be identified.
   *
   * @returns {void}
   */
  onEnd () {
    this.isFinalizing = true
    // Playwright 1.60 and 1.61 only expose reporter errors through this exact console call.
    // eslint-disable-next-line no-console
    const originalConsoleError = console.error
    DatadogPlaywrightReporter.originalConsoleError = originalConsoleError
    const reporter = this
    // eslint-disable-next-line no-console
    DatadogPlaywrightReporter.consoleError = console.error = function (message, error) {
      if (isPlaywrightReporterError(message)) {
        reporter.onError(error)
      }
      return originalConsoleError.apply(this, arguments)
    }
  }

  /**
   * Reports errors emitted by Playwright while later reporters are finalizing.
   *
   * @param {unknown} error
   * @returns {void}
   */
  onError (error) {
    if (this.isFinalizing) reporterErrorCh.publish(error)
  }

  /**
   * Keeps the internal reporter from affecting Playwright's output reporter selection.
   *
   * @returns {boolean}
   */
  printsToStdio () {
    return false
  }
}

module.exports = DatadogPlaywrightReporter
