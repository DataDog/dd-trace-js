'use strict'

const zlib = require('node:zlib')

const VALIDATION_APP_URL = 'https://app-dev-local.datadoghq.com/ci/test/validation'

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
 * Gets a validation web app URL for a payload.
 *
 * @param {object} payload validation payload
 * @returns {string} validation web app URL
 */
function getValidationAppUrl (payload) {
  return `${VALIDATION_APP_URL}#pako:${encodeValidationPayload(payload)}`
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
