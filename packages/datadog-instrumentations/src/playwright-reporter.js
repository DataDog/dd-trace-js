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
 * @param {unknown} error - Second console.error argument
 * @returns {boolean}
 */
function isPlaywrightReporterError (message, error) {
  if (message !== PLAYWRIGHT_REPORTER_ERROR_MESSAGE || error == null) return false

  const stack = new Error('Playwright reporter error provenance').stack
  const caller = stack?.split('\n', 4)[3]
  return PLAYWRIGHT_REPORTER_ERROR_CALLER_RE.test(caller || '')
}

module.exports = class DatadogPlaywrightReporter {
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
    this.originalConsoleError = originalConsoleError
    const reporter = this
    // eslint-disable-next-line no-console
    this.consoleError = console.error = function (message, error) {
      if (isPlaywrightReporterError(message, error)) {
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
   * Restores console error after all reporters have finalized.
   *
   * @returns {void}
   */
  onExit () {
    // eslint-disable-next-line no-console
    if (console.error === this.consoleError) {
      // eslint-disable-next-line no-console
      console.error = this.originalConsoleError
    }
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
