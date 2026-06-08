'use strict'

const zlib = require('node:zlib')

const VALIDATION_APP_URL = 'https://app-dev-local.datadoghq.com/ci/test/validation'
const SECRET_KEY_RE = /(?:API_?KEY|TOKEN|SECRET|PASSWORD)/i

/**
 * Builds the payload rendered by the local Test Optimization validation web app.
 *
 * @param {object} input validation input
 * @param {object} input.analysis intake analysis report
 * @param {object|undefined} input.staticReport static diagnosis report
 * @param {string|undefined} input.testCommand selected test command
 * @param {string|undefined} input.testExitCode selected test command exit code
 * @param {string|undefined} input.testResult selected test command result summary
 * @param {Array<Array<string>>|undefined} input.env live run environment entries
 * @param {object|undefined} input.artifacts artifact paths and URLs
 * @returns {object} validation payload
 */
function buildValidationPayload (input) {
  const analysis = input.analysis
  const summary = analysis.summary
  const findingItems = analysis.findings.map(getFindingPayload)
  const result = {
    status: getResultStatus(analysis.findings),
    stage: analysis.primaryStage,
  }

  return {
    version: 1,
    source: 'dd-trace-js',
    type: 'test-optimization-validation',
    result,
    findings: {
      status: result.status,
      stage: result.stage,
      primary: getPrimaryFinding(findingItems, result.stage),
      items: findingItems,
    },
    summary: {
      anyRequestReceived: summary.anyRequestReceived,
      requestCount: summary.requestCount,
      citestcycle: {
        payloadCount: summary.citestcycle.payloadCount,
      },
      events: {
        counts: summary.events.counts,
        missingLevels: summary.events.missingLevels,
        total: summary.events.total,
        unlinkedTestSpans: summary.events.unlinkedTestSpans,
      },
      metadata: {
        emptyFields: summary.metadata.emptyFields,
        repositoryUrlPresent: !!summary.metadata.repositoryUrl,
        commitShaPresent: !!summary.metadata.commitSha,
        branchPresent: !!summary.metadata.branch,
      },
      settings: {
        requestCount: summary.settings.requestCount,
      },
      efd: {
        settingsEnabled: summary.efd.settingsEnabled,
        requested: summary.efd.requested,
        knownTestsReceived: summary.efd.knownTestsReceived,
        newTests: summary.efd.newTests.length,
        retriedNewTests: summary.efd.retriedNewTests,
        retriedNewTestNames: summary.efd.retriedNewTestNames,
      },
      coverage: {
        expected: summary.coverage.expected,
        citestcov: summary.coverage.citestcov,
        coverageReport: summary.coverage.coverageReport,
      },
      decodeErrors: summary.decodeErrors.map(error => ({
        path: error.path,
        error: error.error,
      })),
    },
    static: getStaticPayload(input.staticReport),
    test: getTestPayload(input),
    env: getEnvPayload(input.env),
    artifacts: getArtifactsPayload(input.artifacts, summary),
  }
}

/**
 * Gets the primary finding for the selected stage.
 *
 * @param {Array<object>} findings finding payloads
 * @param {string} stage primary stage
 * @returns {object|undefined} primary finding
 */
function getPrimaryFinding (findings, stage) {
  return findings.find(finding => finding.stage === stage) || findings[0]
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
 * Gets the validation status from fixed-rule findings.
 *
 * @param {Array<object>} findings fixed-rule findings
 * @returns {string} validation status
 */
function getResultStatus (findings) {
  if (findings.some(finding => finding.status === 'error')) return 'error'
  if (findings.some(finding => finding.status === 'warning')) return 'warning'
  if (findings.some(finding => finding.status === 'ok')) return 'ok'

  return findings[0]?.status || 'unknown'
}

/**
 * Gets a compact finding payload.
 *
 * @param {object} finding fixed-rule finding
 * @returns {object} finding payload
 */
function getFindingPayload (finding) {
  return {
    status: finding.status,
    stage: finding.stage,
    observation: finding.observation,
    cause: finding.cause,
    fix: finding.fix,
  }
}

/**
 * Gets static diagnosis data for the validation payload.
 *
 * @param {object|undefined} staticReport static diagnosis report
 * @returns {object|undefined} static payload
 */
function getStaticPayload (staticReport) {
  if (!staticReport) return

  return {
    ddTraceVersion: staticReport.ddTraceVersion,
    frameworks: getFrameworks(staticReport),
    findings: getStaticFindings(staticReport),
  }
}

/**
 * Gets supported framework summaries.
 *
 * @param {object} staticReport static diagnosis report
 * @returns {Array<object>} framework payloads
 */
function getFrameworks (staticReport) {
  const frameworks = Array.isArray(staticReport.supportedFrameworks) ? staticReport.supportedFrameworks : []

  return frameworks.map(framework => ({
    id: framework.id,
    name: framework.name,
    version: getFrameworkVersion(framework),
  }))
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

/**
 * Gets static warnings and errors.
 *
 * @param {object} staticReport static diagnosis report
 * @returns {Array<object>} static finding payloads
 */
function getStaticFindings (staticReport) {
  const results = Array.isArray(staticReport.results) ? staticReport.results : []
  const findings = []

  for (const result of results) {
    if (result.status !== 'error' && result.status !== 'warning') continue

    findings.push({
      status: result.status,
      title: result.title,
      message: result.message,
      recommendation: result.recommendation,
    })
  }

  return findings
}

/**
 * Gets selected test command data for the validation payload.
 *
 * @param {object} input validation input
 * @returns {object|undefined} test payload
 */
function getTestPayload (input) {
  if (!input.testCommand && !input.testExitCode && !input.testResult) return

  return {
    command: input.testCommand,
    exitCode: input.testExitCode,
    result: input.testResult,
  }
}

/**
 * Gets sanitized env entries for the validation payload.
 *
 * @param {Array<Array<string>>|undefined} env live run environment entries
 * @returns {Array<object>|undefined} env payload
 */
function getEnvPayload (env) {
  if (!Array.isArray(env)) return

  return env.map(([key, value]) => ({
    key,
    value: maskEnvValue(key, value),
  }))
}

/**
 * Masks secret-looking env values.
 *
 * @param {string} key env key
 * @param {string} value env value
 * @returns {string} safe value
 */
function maskEnvValue (key, value) {
  if (value === 'debug') return value
  if (SECRET_KEY_RE.test(key)) return '<redacted>'

  return value
}

/**
 * Gets artifact references for the validation payload.
 *
 * @param {object|undefined} artifacts explicit artifact references
 * @param {object} summary intake summary
 * @returns {object} artifact payload
 */
function getArtifactsPayload (artifacts, summary) {
  return {
    htmlFileUrl: artifacts?.htmlFileUrl || summary.artifacts.htmlFileUrl,
    htmlPath: artifacts?.htmlPath || summary.artifacts.htmlPath,
    intakePath: artifacts?.intakePath || summary.artifacts.intakePath,
    intakeUrl: artifacts?.intakeUrl || summary.artifacts.intakeUrl,
    staticPath: artifacts?.staticPath,
    agentReportPath: artifacts?.agentReportPath,
    agentJsonReportPath: artifacts?.agentJsonReportPath,
    finalReportPath: artifacts?.finalReportPath,
  }
}

module.exports = {
  buildValidationPayload,
  encodeValidationPayload,
  getValidationAppUrl,
}
