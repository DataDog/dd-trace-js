'use strict'

const { channel } = require('dc-polyfill')

const reporterErrorCh = channel('ci:playwright:reporter:error')
const reporterRunSummaryCh = channel('ci:playwright:reporter:run-summary')
const reporterSuiteHookErrorCh = channel('ci:playwright:reporter:suite-hook-error')
const suitesWithHookErrors = new Set()
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
    return PLAYWRIGHT_REPORTER_ERROR_CALLER_RE.test(`at ${stack?.[2]?.toString() || ''}`)
  } finally {
    Error.prepareStackTrace = originalPrepareStackTrace
  }
}

/**
 * Returns whether a finalized Playwright result contains a failed suite hook.
 *
 * @param {Array<object>} steps
 * @returns {boolean}
 */
function hasFailedSuiteHook (steps) {
  if (!steps) return false

  for (const step of steps) {
    if (step.error && (step.title === 'beforeAll hook' || step.title === 'afterAll hook')) return true
    if (hasFailedSuiteHook(step.steps)) return true
  }
  return false
}

class DatadogPlaywrightReporter {
  /**
   * Creates a reporter that observes the finalized Playwright result independently of user reporters.
   *
   * @param {object} [options]
   * @param {boolean} [options.captureReporterErrors]
   */
  constructor ({ captureReporterErrors = true } = {}) {
    this.captureReporterErrors = captureReporterErrors
    this.fatalErrorCount = 0
  }

  /**
   * Identifies this reporter as implementing Playwright's reporter v2 contract.
   *
   * @returns {'v2'}
   */
  version () {
    return 'v2'
  }

  /**
   * Implements the reporter v2 lifecycle hook required by older Playwright versions.
   *
   * @param {object} config
   * @returns {void}
   */
  onConfigure (config) {
    this.failOnFlakyTests = config.failOnFlakyTests
  }

  /**
   * Restores console error after Playwright completes the reporter lifecycle.
   *
   * @returns {void}
   */
  static restoreConsoleError () {
    // eslint-disable-next-line no-console
    if (console.error === DatadogPlaywrightReporter.consoleError) {
      try {
        // eslint-disable-next-line no-console
        console.error = DatadogPlaywrightReporter.originalConsoleError
      } catch {}
    }
    DatadogPlaywrightReporter.consoleError = undefined
    DatadogPlaywrightReporter.originalConsoleError = undefined
  }

  /**
   * Records the suite so finalized test outcomes can be counted in onEnd.
   *
   * @param {object} configOrSuite
   * @param {object} [suite]
   * @returns {void}
   */
  onBegin (configOrSuite, suite) {
    this.suite = suite || configOrSuite
    if (suite) this.failOnFlakyTests = configOrSuite.failOnFlakyTests
    suitesWithHookErrors.clear()
  }

  /**
   * Implements the reporter v2 lifecycle hook required by older Playwright versions.
   *
   * @returns {void}
   */
  onTestBegin () {}

  /**
   * Implements the reporter v2 lifecycle hook required by older Playwright versions.
   *
   * @returns {void}
   */
  onStdOut () {}

  /**
   * Implements the reporter v2 lifecycle hook required by older Playwright versions.
   *
   * @returns {void}
   */
  onStdErr () {}

  /**
   * Implements the reporter v2 lifecycle hook required by older Playwright versions.
   *
   * @returns {void}
   */
  onTestEnd () {}

  /**
   * Implements the reporter v2 lifecycle hook required by older Playwright versions.
   *
   * @returns {void}
   */
  onStepBegin () {}

  /**
   * Implements the reporter v2 lifecycle hook required by older Playwright versions.
   *
   * @returns {void}
   */
  onStepEnd () {}

  /**
   * Marks the beginning of reporter finalization so later reporter errors can be identified.
   *
   * @returns {void}
   */
  onEnd () {
    let failureCount = this.fatalErrorCount
    let quarantinedFailureCount = 0
    let hasIncompleteTests = suitesWithHookErrors.size > 0
    const tests = this.suite?.allTests?.()
    if (tests) {
      for (const test of tests) {
        const outcome = test.outcome()
        const finalResult = test.results.at(-1)
        hasIncompleteTests ||= hasFailedSuiteHook(finalResult?.steps)
        if (outcome === 'unexpected' || (outcome === 'flaky' && this.failOnFlakyTests)) {
          failureCount += 1
          const finalResultStatus = finalResult?.status
          const hasFailed = finalResultStatus === 'failed' || finalResultStatus === 'timedOut'
          if (outcome === 'unexpected' && hasFailed && test._ddIsQuarantined && !test._ddIsAttemptToFix) {
            quarantinedFailureCount += 1
          }
        } else if (outcome === 'skipped' && !test._ddShouldSkipEfdRetry &&
          (!test._ddIsDisabled || test._ddIsAttemptToFix)) {
          const { results } = test
          hasIncompleteTests ||= results.some(result => result.status === 'interrupted') ||
            !results.length || test.expectedStatus !== 'skipped'
        }
      }
    }
    reporterRunSummaryCh.publish({ failureCount, quarantinedFailureCount, hasIncompleteTests })
    suitesWithHookErrors.clear()

    if (!this.captureReporterErrors) return

    this.isFinalizing = true
    // Playwright 1.60 and 1.61 only expose reporter errors through this exact console call.
    // eslint-disable-next-line no-console
    const originalConsoleError = console.error
    const reporter = this
    const consoleError = function (message, error) {
      if (isPlaywrightReporterError(message)) {
        reporter.onError(error)
      }
      return originalConsoleError.apply(this, arguments)
    }
    try {
      // eslint-disable-next-line no-console
      console.error = consoleError
    } catch {
      return
    }
    // An accessor may ignore the assignment without throwing.
    // eslint-disable-next-line no-console
    if (console.error !== consoleError) return

    DatadogPlaywrightReporter.originalConsoleError = originalConsoleError
    DatadogPlaywrightReporter.consoleError = consoleError
  }

  /**
   * Implements the reporter v2 lifecycle hook required by older Playwright versions.
   *
   * @returns {void}
   */
  onExit () {}

  /**
   * Reports errors emitted by Playwright while later reporters are finalizing.
   *
   * @param {unknown} error
   * @returns {void}
   */
  onError (error) {
    if (this.isFinalizing) {
      reporterErrorCh.publish(error)
    } else {
      this.fatalErrorCount += 1
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

reporterSuiteHookErrorCh.subscribe((testSuiteAbsolutePath) => {
  suitesWithHookErrors.add(testSuiteAbsolutePath)
})

module.exports = DatadogPlaywrightReporter
