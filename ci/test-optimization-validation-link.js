'use strict'

const zlib = require('node:zlib')

const VALIDATION_APP_PATH = 'ci/test/validation'

/**
 * Builds the payload rendered by the local Test Optimization validation web app.
 *
 * @param {object} input validation input
 * @param {object} input.analysis intake analysis report
 * @param {object|undefined} input.staticReport static diagnosis report
 * @param {string|undefined} input.testCommand selected test command
 * @param {string|undefined} input.testExitCode selected test command exit code
 * @param {string|undefined} input.testResult selected test command result summary
 * @param {string|undefined} input.newTestSnippet EFD temporary test snippet
 * @param {string|undefined} input.flakyTestSnippet Auto Test Retries temporary flaky test snippet
 * @param {object|undefined} input.artifacts artifact paths and URLs
 * @returns {object} validation payload
 */
function buildValidationPayload (input) {
  const analysis = input.analysis
  const summary = analysis.summary
  const checks = getChecks(input, analysis)
  const status = getChecksStatus(checks)

  return {
    version: 2,
    source: 'dd-trace-js',
    type: 'test-optimization-validation',
    status,
    checks,
    artifacts: {
      htmlFileUrl: input.artifacts?.htmlFileUrl || summary.artifacts.htmlFileUrl,
      htmlPath: input.artifacts?.htmlPath || summary.artifacts.htmlPath,
    },
    framework: getFramework(input.staticReport),
  }
}

/**
 * Gets validation checks.
 *
 * @param {object} input validation input
 * @param {object} analysis intake analysis report
 * @returns {Array<object>} validation checks
 */
function getChecks (input, analysis) {
  const checks = [getBasicReportingCheck(input, analysis)]

  if (isEfdCheckAttempted(input, analysis)) {
    checks.push(getEfdCheck(input, analysis))
  }

  if (isAutoTestRetriesCheckAttempted(input, analysis)) {
    checks.push(getAutoTestRetriesCheck(input, analysis))
  }

  if (isTestManagementCheckAttempted(analysis)) {
    checks.push(getTestManagementCheck(input, analysis))
  }

  return checks
}

/**
 * Gets the overall check status.
 *
 * @param {Array<object>} checks validation checks
 * @returns {string} status
 */
function getChecksStatus (checks) {
  return checks.some(check => check.status === 'failed') ? 'failed' : 'ok'
}

/**
 * Gets the basic reporting validation check.
 *
 * @param {object} input validation input
 * @param {object} analysis intake analysis report
 * @returns {object} basic reporting check
 */
function getBasicReportingCheck (input, analysis) {
  const summary = analysis.summary
  const events = getEventCounts(summary)
  const status = getBasicReportingStatus(summary)

  return {
    id: 'basic-reporting',
    name: 'Basic reporting',
    status,
    steps: [
      {
        id: 'setup-intake',
        name: 'Set up intake',
        status: summary.artifacts.intakeUrl ? 'ok' : 'failed',
      },
      {
        id: 'run-tests',
        name: 'Run tests',
        status: getTestCommandStatus(input),
        command: input.testCommand,
        exitCode: input.testExitCode,
        result: input.testResult,
      },
      {
        id: 'check-events',
        name: 'Check that events show up',
        status,
        evidence: {
          requestCount: summary.requestCount,
          citestcyclePayloads: summary.citestcycle.payloadCount,
          events,
          missingLevels: summary.events.missingLevels,
          decodeErrors: summary.decodeErrors.length,
        },
      },
    ],
  }
}

/**
 * Gets the EFD validation check.
 *
 * @param {object} input validation input
 * @param {object} analysis intake analysis report
 * @returns {object} EFD check
 */
function getEfdCheck (input, analysis) {
  const summary = analysis.summary
  const status = getEfdStatus(summary)

  return {
    id: 'efd-new-test-detection-and-retry',
    name: 'EFD new test detection and retry',
    status,
    steps: [
      {
        id: 'setup-intake',
        name: 'Set up intake',
        status: summary.efd.settingsEnabled && summary.efd.requested ? 'ok' : 'failed',
        evidence: {
          settingsEnabled: summary.efd.settingsEnabled,
          knownTestsRequested: summary.efd.requested,
          knownTestsReceived: summary.efd.knownTestsReceived,
        },
      },
      {
        id: 'add-new-test',
        name: 'Add new test',
        status: input.newTestSnippet || summary.efd.newTests.length > 0 ? 'ok' : 'failed',
        snippet: input.newTestSnippet,
        evidence: {
          newTestsObserved: summary.efd.newTests.length,
          retriedNewTestNames: summary.efd.retriedNewTestNames,
        },
      },
      {
        id: 'run-tests',
        name: 'Run tests',
        status: getTestCommandStatus(input),
        command: input.testCommand,
        exitCode: input.testExitCode,
        result: input.testResult,
      },
      {
        id: 'check-new-test-retried',
        name: 'Check that new test is retried',
        status,
        evidence: {
          retriedNewTests: summary.efd.retriedNewTests,
          retriedNewTestNames: summary.efd.retriedNewTestNames,
        },
      },
    ],
  }
}

/**
 * Gets the Auto Test Retries validation check.
 *
 * @param {object} input validation input
 * @param {object} analysis intake analysis report
 * @returns {object} Auto Test Retries check
 */
function getAutoTestRetriesCheck (input, analysis) {
  const summary = analysis.summary
  const status = getAutoTestRetriesStatus(summary)

  return {
    id: 'auto-test-retries',
    name: 'Auto test retries',
    status,
    steps: [
      {
        id: 'setup-intake',
        name: 'Set up intake',
        status: summary.atr.settingsEnabled ? 'ok' : 'failed',
        evidence: {
          settingsEnabled: summary.atr.settingsEnabled,
        },
      },
      {
        id: 'make-known-test-flaky',
        name: 'Make an already known test flaky',
        status: input.flakyTestSnippet || summary.atr.failedExecutions > 0 ? 'ok' : 'failed',
        snippet: input.flakyTestSnippet,
        evidence: {
          failedExecutions: summary.atr.failedExecutions,
          failedThenPassedRetryTestNames: summary.atr.failedThenPassedRetryTestNames,
        },
      },
      {
        id: 'run-tests',
        name: 'Run tests',
        status: getTestCommandStatus(input),
        command: input.testCommand,
        exitCode: input.testExitCode,
        result: input.testResult,
      },
      {
        id: 'check-failing-and-passing-executions',
        name: 'Check that failing and passing executions were reported',
        status: summary.atr.failedExecutions > 0 && summary.atr.passedExecutions > 0 ? 'ok' : 'failed',
        evidence: {
          failedExecutions: summary.atr.failedExecutions,
          passedExecutions: summary.atr.passedExecutions,
          failedThenPassedRetryTests: summary.atr.failedThenPassedRetryTests,
          failedThenPassedRetryTestNames: summary.atr.failedThenPassedRetryTestNames,
        },
      },
      {
        id: 'check-passing-execution-marked-retry',
        name: 'Check that the passing execution is marked as a retry',
        status,
        evidence: {
          passedRetryTests: summary.atr.passedRetryTests,
          passedRetryTestNames: summary.atr.passedRetryTestNames,
          retriedTests: summary.atr.retriedTests,
          retriedTestNames: summary.atr.retriedTestNames,
        },
      },
    ],
  }
}

/**
 * Gets the Test Management validation check.
 *
 * @param {object} input validation input
 * @param {object} analysis intake analysis report
 * @returns {object} Test Management check
 */
function getTestManagementCheck (input, analysis) {
  const summary = analysis.summary
  const subchecks = [
    getTestManagementSubcheck(input, summary, 'disabled', 'Disabled tests', '0'),
    getTestManagementSubcheck(input, summary, 'quarantined', 'Quarantined tests', '0'),
    getTestManagementSubcheck(input, summary, 'attemptToFix', 'Attempt-to-fix tests', 'non-zero'),
  ]

  return {
    id: 'test-management',
    name: 'Test Management',
    status: getTestManagementStatus(summary, subchecks),
    steps: [
      {
        id: 'setup-intake',
        name: 'Set up Test Management intake',
        status: summary.tm.settingsEnabled && summary.tm.propertiesEndpointCalled ? 'ok' : 'failed',
        evidence: {
          settingsEnabled: summary.tm.settingsEnabled,
          propertiesEndpointCalled: summary.tm.propertiesEndpointCalled,
          propertiesReturned: summary.tm.returnedProperties,
          returnedPropertyIdentities: summary.tm.returnedPropertyIdentities,
          matchedPropertyIdentities: summary.tm.matchedPropertyIdentities,
          unmatchedPropertyIdentities: summary.tm.unmatchedPropertyIdentities,
        },
      },
      {
        id: 'run-tests',
        name: 'Run managed test',
        status: getTestCommandStatus(input),
        command: input.testCommand,
        exitCode: input.testExitCode,
        result: input.testResult,
      },
      ...subchecks,
    ],
  }
}

/**
 * Gets one Test Management subcheck step.
 *
 * @param {object} input validation input
 * @param {object} summary intake summary
 * @param {string} id subcheck id
 * @param {string} name subcheck name
 * @param {string} expectedExitCode expected command exit code
 * @returns {object} validation step
 */
function getTestManagementSubcheck (input, summary, id, name, expectedExitCode) {
  const subcheck = summary.tm[id]
  const expectedSubcheck = summary.tm.expectedSubcheck
  const skipped = expectedSubcheck && expectedSubcheck !== id

  return {
    id,
    name,
    status: skipped ? 'skipped' : getTestManagementSubcheckStatus(input, subcheck, expectedExitCode),
    evidence: {
      expectedExitCode,
      actualExitCode: input.testExitCode,
      managedTestIdentities: subcheck.identities,
      observedStatuses: subcheck.observedStatuses,
      observedFinalStatuses: subcheck.observedFinalStatuses,
      observedRetryReasons: subcheck.observedRetryReasons,
      reason: skipped ? `not run in ${summary.tm.expectedSubcheck} mode` : subcheck.reason,
      tests: subcheck.tests,
    },
  }
}

/**
 * Checks whether the EFD check was attempted.
 *
 * @param {object} input validation input
 * @param {object} analysis intake analysis report
 * @returns {boolean} true if EFD evidence is present
 */
function isEfdCheckAttempted (input, analysis) {
  const efd = analysis.summary.efd
  return !!(
    input.newTestSnippet ||
    efd.settingsEnabled ||
    efd.requested ||
    efd.knownTestsReceived > 0 ||
    efd.newTests.length > 0 ||
    efd.retriedNewTests > 0
  )
}

/**
 * Checks whether the Auto Test Retries check was attempted.
 *
 * @param {object} input validation input
 * @param {object} analysis intake analysis report
 * @returns {boolean} true if Auto Test Retries evidence is present
 */
function isAutoTestRetriesCheckAttempted (input, analysis) {
  const atr = analysis.summary.atr
  return !!(
    input.flakyTestSnippet ||
    atr.settingsEnabled ||
    atr.retriedTests > 0 ||
    atr.failedThenPassedRetryTests > 0
  )
}

/**
 * Checks whether the Test Management check was attempted.
 *
 * @param {object} analysis intake analysis report
 * @returns {boolean} true if Test Management evidence is present
 */
function isTestManagementCheckAttempted (analysis) {
  const tm = analysis.summary.tm

  return !!(
    tm.settingsEnabled ||
    tm.propertiesEndpointCalled ||
    tm.returnedProperties > 0 ||
    tm.managedTests.count > 0 ||
    tm.expectedSubcheck
  )
}

/**
 * Gets basic reporting check status.
 *
 * @param {object} summary intake summary
 * @returns {string} check status
 */
function getBasicReportingStatus (summary) {
  if (summary.citestcycle.payloadCount === 0) return 'failed'
  if (summary.events.missingLevels.length > 0) return 'failed'
  if (summary.decodeErrors.length > 0) return 'failed'

  return 'ok'
}

/**
 * Gets EFD check status.
 *
 * @param {object} summary intake summary
 * @returns {string} check status
 */
function getEfdStatus (summary) {
  if (!summary.efd.settingsEnabled) return 'failed'
  if (!summary.efd.requested) return 'failed'
  if (summary.efd.knownTestsReceived === 0) return 'failed'
  if (summary.efd.retriedNewTests === 0) return 'failed'

  return 'ok'
}

/**
 * Gets Auto Test Retries check status.
 *
 * @param {object} summary intake summary
 * @returns {string} check status
 */
function getAutoTestRetriesStatus (summary) {
  if (!summary.atr.settingsEnabled) return 'failed'
  if (summary.atr.failedExecutions === 0) return 'failed'
  if (summary.atr.passedExecutions === 0) return 'failed'
  if (summary.atr.passedRetryTests === 0) return 'failed'
  if (summary.atr.failedThenPassedRetryTests === 0) return 'failed'

  return 'ok'
}

/**
 * Gets the aggregate Test Management check status.
 *
 * @param {object} summary intake summary
 * @param {Array<object>} subchecks Test Management subcheck steps
 * @returns {string} check status
 */
function getTestManagementStatus (summary, subchecks) {
  if (
    !summary.tm.settingsEnabled ||
    !summary.tm.propertiesEndpointCalled ||
    summary.tm.returnedProperties === 0 ||
    summary.tm.unmatchedPropertyIdentities.length > 0
  ) {
    return 'failed'
  }

  const attempted = subchecks.filter(subcheck => subcheck.status !== 'skipped')
  if (attempted.length === 0) return 'skipped'
  if (attempted.some(subcheck => subcheck.status === 'failed')) return 'failed'
  if (attempted.some(subcheck => subcheck.status === 'unknown')) return 'unknown'

  return 'ok'
}

/**
 * Gets a Test Management subcheck status.
 *
 * @param {object} input validation input
 * @param {object} subcheck analyzer subcheck summary
 * @param {string} expectedExitCode expected command exit code
 * @returns {string} validation step status
 */
function getTestManagementSubcheckStatus (input, subcheck, expectedExitCode) {
  if (subcheck.status === 'not run') return 'failed'
  if (subcheck.status !== 'passed') return 'failed'
  if (input.testExitCode === undefined) return 'unknown'

  const exitCode = String(input.testExitCode)
  if (expectedExitCode === 'non-zero') return exitCode === '0' ? 'failed' : 'ok'

  return exitCode === expectedExitCode ? 'ok' : 'failed'
}

/**
 * Gets test command step status.
 *
 * @param {object} input validation input
 * @returns {string} step status
 */
function getTestCommandStatus (input) {
  if (input.testExitCode === undefined && !input.testCommand && !input.testResult) return 'unknown'

  return input.testExitCode === '0' || input.testExitCode === 0 ? 'ok' : 'failed'
}

/**
 * Gets compact event counts.
 *
 * @param {object} summary intake summary
 * @returns {object} compact event counts
 */
function getEventCounts (summary) {
  return {
    sessions: summary.events.counts.test_session_end,
    modules: summary.events.counts.test_module_end,
    suites: summary.events.counts.test_suite_end,
    tests: summary.events.counts.test,
  }
}

/**
 * Encodes a validation payload with the same deflate format produced by pako.deflate().
 *
 * @param {object} payload validation payload
 * @returns {string} URL-safe base64 encoded deflate payload
 */
function encodeValidationPayload (payload) {
  return zlib.deflateSync(Buffer.from(JSON.stringify(payload))).toString('base64url')
}

/**
 * Gets a validation web app path for a payload.
 *
 * @param {object} payload validation payload
 * @returns {string} validation web app path
 */
function getValidationAppUrl (payload) {
  return `${VALIDATION_APP_PATH}#pako:${encodeValidationPayload(payload)}`
}

/**
 * Gets the detected test framework.
 *
 * @param {object|undefined} staticReport static diagnosis report
 * @returns {object|undefined} framework payload
 */
function getFramework (staticReport) {
  if (!staticReport) return

  const frameworks = Array.isArray(staticReport.supportedFrameworks) ? staticReport.supportedFrameworks : []
  const framework = frameworks[0]
  if (!framework) return

  return {
    id: framework.id,
    name: framework.name,
    version: getFrameworkVersion(framework),
  }
}

/**
 * Gets the first detected framework version.
 *
 * @param {object} framework supported framework summary
 * @returns {string|undefined} framework version
 */
function getFrameworkVersion (framework) {
  const detections = Array.isArray(framework.versionDetections) ? framework.versionDetections : []
  return detections[0]?.version || detections[0]?.rawVersion
}

module.exports = {
  buildValidationPayload,
  encodeValidationPayload,
  getValidationAppUrl,
}
