'use strict'

const path = require('node:path')
const { pathToFileURL } = require('node:url')

const {
  buildValidationPayload,
  getValidationAppUrl,
} = require('./test-optimization-validation-link')

const GIT_METADATA_FIELDS = [
  ['repositoryUrl', 'repository_url'],
  ['commitSha', 'sha'],
  ['branch', 'branch'],
]
const EFD_SETTINGS_MODES = new Set(['debug-all', 'efd'])
const ATR_SETTINGS_MODES = new Set(['atr', 'debug-all'])
const TEST_MANAGEMENT_SETTINGS_MODES = new Set([
  'tm-disabled',
  'tm-quarantined',
  'tm-attempt-to-fix',
  'tm-attempt-to-fix-priority',
])
const TEST_FRAMEWORK = 'test.framework'
const TEST_IS_NEW = 'test.is_new'
const TEST_IS_RETRY = 'test.is_retry'
const TEST_FINAL_STATUS = 'test.final_status'
const TEST_COMMAND = 'test.command'
const TEST_MODULE = 'test.module'
const TEST_NAME = 'test.name'
const TEST_PARAMETERS = 'test.parameters'
const TEST_RETRY_REASON = 'test.retry_reason'
const TEST_STATUS = 'test.status'
const TEST_SUITE = 'test.suite'
const TEST_RETRY_REASON_AUTO_TEST_RETRY = 'auto_test_retry'
const TEST_RETRY_REASON_EARLY_FLAKE_DETECTION = 'early_flake_detection'
const TEST_RETRY_REASON_ATTEMPT_TO_FIX = 'attempt_to_fix'
const TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED = 'test.test_management.attempt_to_fix_passed'
const TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX = 'test.test_management.is_attempt_to_fix'
const TEST_MANAGEMENT_IS_DISABLED = 'test.test_management.is_test_disabled'
const TEST_MANAGEMENT_IS_QUARANTINED = 'test.test_management.is_quarantined'
const BASIC_EVENT_LEVELS = {
  test_session_end: 'test session',
  test_module_end: 'test module',
  test_suite_end: 'test suite',
  test: 'test',
}
const FEATURE_SAMPLE_LIMIT = 3

/**
 * Builds a fixed-rule diagnosis from a fake intake artifact.
 *
 * @param {object} artifact fake intake artifact
 * @returns {object} analysis report
 */
function analyzeIntakeArtifact (artifact) {
  const summary = summarizeIntakeArtifact(artifact)
  const findings = []
  const settingsMode = artifact?.intake?.settingsMode
  const advancedFeatureChecks = EFD_SETTINGS_MODES.has(settingsMode)
  const efdChecks = EFD_SETTINGS_MODES.has(settingsMode)
  const atrChecks = ATR_SETTINGS_MODES.has(settingsMode)
  const testManagementChecks = TEST_MANAGEMENT_SETTINGS_MODES.has(settingsMode)

  if (!summary.anyRequestReceived) {
    addFinding(findings, 'error', 'Nothing', {
      observation: 'anyRequestReceived: false',
      cause:
        'The tracer was not loaded into the test process, the tracer was not pointed at the intake, or tests ' +
        'did not run.',
      fix:
        'Check NODE_OPTIONS="-r dd-trace/ci/init" reached the test process. Cypress and Playwright may need ' +
        'framework-specific wiring. Confirm the command actually selected and executed tests.',
    })
    return finishAnalysis(summary, findings)
  }

  if (summary.onlyInfoSeen) {
    addFinding(findings, 'error', 'Connected, no settings', {
      observation: 'Only /info was seen.',
      cause:
        'The tracer connected to an agent-like endpoint, but exporter initialization or EVP proxy detection ' +
        'failed.',
      fix: 'Check agent vs agentless routing. Agent-proxy mode needs EVP v2 support on the Datadog Agent.',
    })
    return finishAnalysis(summary, findings)
  }

  if (summary.settings.requestCount > 0 && summary.metadata.emptyFields.length > 0) {
    addFinding(findings, 'warning', 'Settings, empty git', {
      observation: `metadata.emptyFields: ${summary.metadata.emptyFields.join(', ')}`,
      cause:
        'Git metadata extraction is failing because git is unavailable, the clone is shallow, HEAD is detached, ' +
        'or CI env is missing.',
      fix:
        'Cross-check the static diagnosis git section. Unshallow the checkout or set DD_GIT_REPOSITORY_URL, ' +
        'DD_GIT_COMMIT_SHA, and DD_GIT_BRANCH.',
    })
  }

  if (summary.settings.requestCount > 0 && summary.citestcycle.payloadCount === 0) {
    addFinding(findings, 'error', 'No session spans', {
      observation: 'citestcycle.payloadCount: 0',
      cause: 'Spans were not generated, were not flushed before process exit, or failed to encode.',
      fix:
        'Check decodeErrors, test process exit behavior, and whether the runner kills workers before ' +
        'dd-trace flushes.',
    })
  }

  if (summary.events.counts.test_session_end > 0 && summary.events.counts.test === 0) {
    addFinding(findings, 'error', 'Session, no test spans', {
      observation: `test_session_end: ${summary.events.counts.test_session_end}, test: 0`,
      cause:
        'Per-test hooks did not fire, often because of a custom runner/environment, unsupported configuration, ' +
        'or an empty subset.',
      fix: 'Check framework configuration and confirm the selected subset actually runs tests.',
    })
  }

  if (summary.citestcycle.payloadCount > 0 && summary.events.missingLevels.length > 0) {
    addFinding(findings, 'error', 'Incomplete test event levels', {
      observation: `missingLevels: ${summary.events.missingLevels.join(', ')}`,
      cause:
        'The tracer reported citestcycle payloads, but one or more expected test event levels were missing.',
      fix:
        'Confirm the selected command runs a normal test session and that the framework instrumentation emits ' +
        'session, module, suite, and test events.',
    })
  }

  if (summary.events.unlinkedTestSpans > 0) {
    addFinding(findings, 'error', 'Unlinked test spans', {
      observation: `unlinkedTestSpans: ${summary.events.unlinkedTestSpans}`,
      cause:
        'Test events do not link back to the emitted test session. This can point to a version mismatch or ' +
        'partial instrumentation.',
      fix: 'Check dd-trace and framework versions. Escalate with the saved intake artifact.',
    })
  }

  if (advancedFeatureChecks && summary.efd.settingsEnabled && !summary.efd.requested) {
    addFinding(findings, 'error', 'Feature not requested', {
      observation: 'efd.requested: false while settings enabled Early Flake Detection.',
      cause: 'The feature flow did not start even though settings enabled it.',
      fix: 'Escalate with the saved intake artifact and test command.',
    })
  }

  if (advancedFeatureChecks && summary.efd.requested && summary.efd.knownTestsReceived === 0) {
    addFinding(findings, 'info', 'Feature requested, empty', {
      observation: 'efd.knownTestsReceived: 0',
      cause: 'This is expected for a first run, a new repository, or a service with no known tests yet.',
      fix: 'Treat this as informational unless the repository already has known tests in Datadog.',
    })
  }

  if (efdChecks && summary.efd.settingsEnabled && summary.efd.requested && summary.efd.retriedNewTests === 0) {
    addFinding(findings, 'error', 'EFD retry missing', {
      observation: 'efd.retriedNewTests: 0',
      cause:
        'Early Flake Detection settings and known tests were requested, but no retry event was observed for a ' +
        'test marked as new.',
      fix:
        'Confirm the second run served known tests from the first run, added a test that is not in that known ' +
        'tests file, and selected that new test in the command.',
    })
  }

  if (efdChecks && summary.efd.retriedNewTests > 0) {
    addFinding(findings, 'ok', 'EFD retried new test', {
      observation: `efd.retriedNewTests: ${summary.efd.retriedNewTests}`,
      cause: 'The second run marked at least one test as new and retried it for Early Flake Detection.',
      fix: 'No EFD retry fix is needed for the selected test subset.',
    })
  }

  if (atrChecks && summary.atr.settingsEnabled && summary.atr.failedThenPassedRetryTests === 0) {
    addFinding(findings, 'error', 'Auto test retry missing', {
      observation: 'atr.failedThenPassedRetryTests: 0',
      cause:
        'Auto Test Retries settings were enabled, but no known flaky test reported a failed attempt followed ' +
        'by a passing retry marked with test.is_retry=true.',
      fix:
        'Confirm the second run served known tests from the first run, changed one already-known selected ' +
        'test to fail once and then pass, and selected that test in the command.',
    })
  }

  if (atrChecks && summary.atr.failedThenPassedRetryTests > 0) {
    addFinding(findings, 'ok', 'Auto test retry reported flaky test', {
      observation: `atr.failedThenPassedRetryTests: ${summary.atr.failedThenPassedRetryTests}`,
      cause:
        'The flaky known test reported both failing and passing executions, and the passing execution was ' +
        'marked as an automatic retry.',
      fix: 'No Auto Test Retries fix is needed for the selected test subset.',
    })
  }

  if (testManagementChecks) {
    addTestManagementFindings(findings, summary, settingsMode)
  }

  if (advancedFeatureChecks && summary.coverage.expected && summary.coverage.citestcov === 0) {
    addFinding(findings, 'warning', 'Coverage missing', {
      observation: 'ITR or coverage was enabled, but citestcov: 0',
      cause: 'Coverage collection did not run or could not upload coverage payloads.',
      fix:
        'Check framework coverage support, coverage configuration, and whether the selected subset can produce ' +
        'coverage.',
    })
  }

  if (
    !testManagementChecks &&
    !findings.some(finding => finding.status === 'error') &&
    summary.events.missingLevels.length === 0
  ) {
    addFinding(findings, 'ok', 'Reporting complete', {
      observation: 'citestcycle payloads include session, module, suite, and test events.',
      cause: 'The basic Test Optimization reporting path is working for the selected command.',
      fix: 'No reporting fix is needed for the selected test subset.',
    })
  }

  return finishAnalysis(summary, findings)
}

/**
 * Summarizes fake intake requests into stable counters and observations.
 *
 * @param {object} artifact fake intake artifact
 * @returns {object} summary
 */
function summarizeIntakeArtifact (artifact) {
  const requests = Array.isArray(artifact?.requests) ? artifact.requests : []
  const endpointCounts = countBy(requests, request => request.category || 'other')
  const events = collectEvents(requests)
  const eventCounts = countBy(events, event => event.type || 'unknown')
  const metadata = getMetadataSummary(requests)
  const settings = getSettingsSummary(artifact, requests)
  const knownTestsReceived = getKnownTestsReceived(artifact)
  const efdSettingsEnabled = !!(
    settings.lastResponse?.known_tests_enabled &&
    settings.lastResponse?.early_flake_detection?.enabled
  )

  return {
    anyRequestReceived: requests.length > 0,
    artifacts: {
      htmlFileUrl: artifact?.intake?.htmlReportFileUrl,
      htmlOpenCommand: artifact?.intake?.htmlReportOpenCommand,
      htmlPath: artifact?.intake?.htmlReportPath,
      intakePath: artifact?.intake?.artifactPath,
      intakeUrl: artifact?.intake?.url,
    },
    onlyInfoSeen: requests.length > 0 && requests.every(request => request.category === 'info'),
    requestCount: requests.length,
    endpoints: endpointCounts,
    settings,
    metadata,
    citestcycle: {
      payloadCount: endpointCounts.citestcycle || 0,
    },
    events: {
      counts: {
        test_session_end: eventCounts.test_session_end || 0,
        test_module_end: eventCounts.test_module_end || 0,
        test_suite_end: eventCounts.test_suite_end || 0,
        test: eventCounts.test || 0,
        span: eventCounts.span || 0,
      },
      missingLevels: getMissingEventLevels(eventCounts),
      samples: getBasicEventSamples(events),
      total: events.length,
      unlinkedTestSpans: countUnlinkedTestSpans(events),
    },
    efd: {
      settingsEnabled: efdSettingsEnabled,
      requested: (endpointCounts.known_tests || 0) > 0,
      knownTestsReceived,
      newTests: getNewTests(events),
      retriedNewTests: getRetriedNewTests(events).length,
      retriedNewTestNames: getRetriedNewTests(events).map(test => test.name),
      samples: getEfdSamples(events),
    },
    atr: getAutoTestRetriesSummary(events, settings),
    tm: getTestManagementSummary(artifact, events, settings, endpointCounts, artifact?.intake?.settingsMode),
    coverage: {
      expected: !!(settings.lastResponse?.itr_enabled || settings.lastResponse?.code_coverage),
      citestcov: endpointCounts.citestcov || 0,
      coverageReport: endpointCounts.cicovreprt || 0,
    },
    decodeErrors: getDecodeErrors(requests),
  }
}

/**
 * Builds known tests from decoded test events in a first-run intake artifact.
 *
 * @param {object} artifact fake intake artifact
 * @returns {object} known tests object keyed by framework, suite, and test name
 */
function buildKnownTestsFromArtifact (artifact) {
  const knownTests = {}

  for (const event of collectEvents(Array.isArray(artifact?.requests) ? artifact.requests : [])) {
    if (event.type !== 'test') continue

    const test = getTestIdentity(event)
    if (!test.name) continue

    knownTests[test.framework] = knownTests[test.framework] || {}
    knownTests[test.framework][test.suite] = knownTests[test.framework][test.suite] || []

    if (!knownTests[test.framework][test.suite].includes(test.name)) {
      knownTests[test.framework][test.suite].push(test.name)
    }
  }

  return knownTests
}

/**
 * Builds a Test Management modules response from a captured baseline test identity.
 *
 * @param {object} artifact fake intake artifact
 * @param {object} properties Test Management properties to return for the selected test
 * @param {object} [options] selection options
 * @param {string} [options.testName] expected test name
 * @returns {{ modules: object, identity: object }} Test Management response modules and selected identity
 */
function buildTestManagementTestsFromArtifact (artifact, properties, options = {}) {
  const events = collectEvents(Array.isArray(artifact?.requests) ? artifact.requests : [])
  const candidates = []

  for (const event of events) {
    if (event.type !== 'test') continue

    const test = getTestIdentity(event)
    if (!test.name) continue
    if (options.testName && test.name !== options.testName && !test.name.endsWith(` ${options.testName}`)) continue

    candidates.push(test)
  }

  if (candidates.length === 0) {
    throw new Error('Could not find a baseline test event for Test Management calibration.')
  }

  const identity = candidates[0]

  return {
    identity,
    modules: {
      [identity.framework]: {
        suites: {
          [identity.suite]: {
            tests: {
              [identity.name]: {
                properties,
              },
            },
          },
        },
      },
    },
  }
}

/**
 * Formats an intake analysis as plain text.
 *
 * @param {object} analysis analysis report
 * @returns {string} human-readable report
 */
function renderAnalysisText (analysis) {
  const validationAppUrl = getValidationAppUrl(buildValidationPayload({ analysis }))

  const lines = [
    `HTML report: ${getHtmlReportReference(analysis)}`,
    `HTML report path: ${analysis.summary.artifacts.htmlPath || 'not available'}`,
    `Open HTML report command: ${analysis.summary.artifacts.htmlOpenCommand || 'not available'}`,
    `Datadog validation: ${validationAppUrl}`,
    'Datadog Test Optimization intake analysis',
    `Primary stage: ${analysis.primaryStage}`,
    `Requests: ${analysis.summary.requestCount}`,
    `citestcycle payloads: ${analysis.summary.citestcycle.payloadCount}`,
    `events: ${analysis.summary.events.total}`,
    'test event levels: ' +
      `sessions=${analysis.summary.events.counts.test_session_end}, ` +
      `modules=${analysis.summary.events.counts.test_module_end}, ` +
      `suites=${analysis.summary.events.counts.test_suite_end}, ` +
      `tests=${analysis.summary.events.counts.test}`,
    ...getEfdTextLines(analysis),
    ...getAutoTestRetriesTextLines(analysis),
    ...getTestManagementTextLines(analysis),
    '',
  ]

  for (const finding of analysis.findings) {
    lines.push(
      `[${finding.status}] ${finding.stage}`,
      `  Observation: ${finding.observation}`,
      `  Cause: ${finding.cause}`,
      `  Fix: ${finding.fix}`,
      ''
    )
  }

  return lines.join('\n').trimEnd()
}

/**
 * Gets optional EFD text lines.
 *
 * @param {object} analysis analysis report
 * @returns {string[]} EFD lines
 */
function getEfdTextLines (analysis) {
  if (!analysis.summary.efd.settingsEnabled && !analysis.summary.efd.requested) return []

  return [
    `EFD settings enabled: ${analysis.summary.efd.settingsEnabled}`,
    `known tests requested: ${analysis.summary.efd.requested}`,
    `known tests received: ${analysis.summary.efd.knownTestsReceived}`,
    `new tests observed: ${analysis.summary.efd.newTests.length}`,
    `retried new tests: ${analysis.summary.efd.retriedNewTests}`,
    ...getEfdExecutionTextLines(analysis.summary.efd.execution),
  ]
}

/**
 * Gets optional EFD execution diagnosis text lines.
 *
 * @param {object|undefined} execution EFD execution diagnosis
 * @returns {string[]} EFD execution lines
 */
function getEfdExecutionTextLines (execution) {
  if (!execution) return []

  return [
    `EFD execution diagnosis: ${execution.diagnosis}`,
  ]
}

/**
 * Gets optional Auto Test Retries text lines.
 *
 * @param {object} analysis analysis report
 * @returns {string[]} Auto Test Retries lines
 */
function getAutoTestRetriesTextLines (analysis) {
  if (!analysis.summary.atr.settingsEnabled && analysis.summary.atr.retriedTests === 0) return []

  return [
    `Auto Test Retries settings enabled: ${analysis.summary.atr.settingsEnabled}`,
    `Auto Test Retries failed executions: ${analysis.summary.atr.failedExecutions}`,
    `Auto Test Retries passed executions: ${analysis.summary.atr.passedExecutions}`,
    `Auto Test Retries passed retry executions: ${analysis.summary.atr.passedRetryTests}`,
    `Auto Test Retries flaky tests reported: ${analysis.summary.atr.failedThenPassedRetryTests}`,
  ]
}

/**
 * Gets optional Test Management text lines.
 *
 * @param {object} analysis analysis report
 * @returns {string[]} Test Management lines
 */
function getTestManagementTextLines (analysis) {
  const tm = analysis.summary.tm
  if (!tm.settingsEnabled && !tm.propertiesEndpointCalled && tm.managedTests.count === 0) return []

  return [
    `Test Management settings enabled: ${tm.settingsEnabled}`,
    `Test Management properties endpoint called: ${tm.propertiesEndpointCalled}`,
    `Test Management properties returned: ${tm.returnedProperties}`,
    `Test Management managed tests observed: ${tm.managedTests.count}`,
    `Test Management disabled status: ${tm.disabled.status}`,
    `Test Management quarantined status: ${tm.quarantined.status}`,
    `Test Management attempt-to-fix status: ${tm.attemptToFix.status}`,
  ]
}

/**
 * Gets the best terminal-facing HTML report reference.
 *
 * @param {object} analysis analysis report
 * @returns {string} HTML report reference
 */
function getHtmlReportReference (analysis) {
  const fileUrl = analysis.summary.artifacts.htmlFileUrl
  const htmlPath = analysis.summary.artifacts.htmlPath

  if (fileUrl) return fileUrl
  if (htmlPath) return pathToFileURL(path.resolve(htmlPath)).href

  return 'not available'
}

/**
 * Adds a normalized fixed-rule finding.
 *
 * @param {Array<object>} findings mutable findings list
 * @param {string} status finding status
 * @param {string} stage decision-tree stage
 * @param {object} details finding details
 */
function addFinding (findings, status, stage, details) {
  findings.push({
    status,
    stage,
    ...details,
  })
}

/**
 * Adds Test Management fixed-rule findings.
 *
 * @param {Array<object>} findings mutable findings list
 * @param {object} summary analysis summary
 * @param {string|undefined} settingsMode fake settings mode
 */
function addTestManagementFindings (findings, summary, settingsMode) {
  if (!summary.tm.settingsEnabled) {
    addFinding(findings, 'error', 'Test Management settings missing', {
      observation: 'tm.settingsEnabled: false',
      cause: 'The fake intake settings response did not enable Test Management.',
      fix: 'Run the subcheck with --settings-mode tm-disabled, tm-quarantined, or tm-attempt-to-fix.',
    })
    return
  }

  if (!summary.tm.propertiesEndpointCalled) {
    addFinding(findings, 'error', 'Test Management properties not requested', {
      observation: 'tm.propertiesEndpointCalled: false',
      cause: 'The tracer did not fetch Test Management test properties after settings enabled the feature.',
      fix: 'Check framework support and whether DD_TEST_MANAGEMENT_ENABLED disabled the feature.',
    })
    return
  }

  if (summary.tm.returnedProperties === 0) {
    addFinding(findings, 'error', 'Test Management properties empty', {
      observation: 'tm.returnedProperties: 0',
      cause: 'The fake intake served no calibrated Test Management properties.',
      fix: 'Run the calibration step and pass --test-management-tests with the generated modules JSON.',
    })
    return
  }

  if (summary.tm.unmatchedPropertyIdentities.length > 0) {
    addFinding(findings, 'error', 'Test Management identity mismatch', {
      observation: `tm.unmatchedPropertyIdentities: ${summary.tm.unmatchedPropertyIdentities.join(', ')}`,
      cause: 'The fake intake returned properties for identities that did not match any managed test span.',
      fix: 'Rebuild the Test Management response from the baseline intake artifact; do not guess suite or test names.',
    })
    return
  }

  const subcheck = getExpectedTestManagementSubcheck(settingsMode)
  const subcheckSummary = subcheck && summary.tm[subcheck]

  if (!subcheckSummary) {
    addFinding(findings, 'info', 'Test Management evidence captured', {
      observation: `tm.managedTests.count: ${summary.tm.managedTests.count}`,
      cause: 'Test Management settings and properties were exchanged.',
      fix: 'Use a tm-disabled, tm-quarantined, or tm-attempt-to-fix settings mode for fixed-rule validation.',
    })
    return
  }

  if (subcheckSummary.status === 'passed') {
    addFinding(findings, 'ok', getTestManagementPassedStage(subcheck), {
      observation: getTestManagementObservation(summary.tm, subcheckSummary),
      cause: subcheckSummary.reason,
      fix: 'No Test Management fix is needed for this subcheck.',
    })
    return
  }

  addFinding(findings, 'error', getTestManagementFailedStage(subcheck), {
    observation: getTestManagementObservation(summary.tm, subcheckSummary),
    cause: subcheckSummary.reason,
    fix: getTestManagementFix(subcheck),
  })
}

/**
 * Gets the passed finding stage for a Test Management subcheck.
 *
 * @param {string} subcheck Test Management subcheck
 * @returns {string} stage
 */
function getTestManagementPassedStage (subcheck) {
  if (subcheck === 'disabled') return 'Test Management disabled reported'
  if (subcheck === 'quarantined') return 'Test Management quarantined reported'

  return 'Test Management attempt-to-fix reported'
}

/**
 * Gets the failed finding stage for a Test Management subcheck.
 *
 * @param {string} subcheck Test Management subcheck
 * @returns {string} stage
 */
function getTestManagementFailedStage (subcheck) {
  if (subcheck === 'disabled') return 'Test Management disabled missing'
  if (subcheck === 'quarantined') return 'Test Management quarantined missing'

  return 'Test Management attempt-to-fix missing'
}

/**
 * Gets a compact Test Management observation.
 *
 * @param {object} tm Test Management summary
 * @param {object} subcheckSummary subcheck summary
 * @returns {string} observation
 */
function getTestManagementObservation (tm, subcheckSummary) {
  return [
    `tm.propertiesEndpointCalled: ${tm.propertiesEndpointCalled}`,
    `tm.returnedProperties: ${tm.returnedProperties}`,
    `managedTests: ${subcheckSummary.tests}`,
    `statuses: ${subcheckSummary.observedStatuses.join(', ') || 'none'}`,
    `finalStatuses: ${subcheckSummary.observedFinalStatuses.join(', ') || 'none'}`,
    `retryReasons: ${subcheckSummary.observedRetryReasons.join(', ') || 'none'}`,
  ].join('; ')
}

/**
 * Gets a Test Management fix recommendation.
 *
 * @param {string} subcheck Test Management subcheck
 * @returns {string} fix recommendation
 */
function getTestManagementFix (subcheck) {
  if (subcheck === 'disabled') {
    return 'Confirm the returned property is disabled:true for the calibrated identity and the framework ' +
      'supports disabled tests.'
  }

  if (subcheck === 'quarantined') {
    return 'Confirm the returned property is quarantined:true and the test actually fails when run normally.'
  }

  return 'Confirm the returned property is attempt_to_fix:true and retries use test.retry_reason=attempt_to_fix.'
}

/**
 * Adds top-level derived fields to the report.
 *
 * @param {object} summary derived summary
 * @param {Array<object>} findings findings list
 * @returns {object} full analysis
 */
function finishAnalysis (summary, findings) {
  const primaryFinding = findings.find(finding => finding.status === 'error') ||
    findings.find(finding => finding.status === 'ok') ||
    findings[0]

  return {
    summary,
    findings,
    primaryStage: primaryFinding?.stage || 'Unknown',
  }
}

/**
 * Counts values from an array.
 *
 * @param {Array<object>} values values to count
 * @param {Function} getKey key selector
 * @returns {object} counts by key
 */
function countBy (values, getKey) {
  const counts = {}

  for (const value of values) {
    const key = getKey(value)
    counts[key] = (counts[key] || 0) + 1
  }

  return counts
}

/**
 * Collects decoded Test Optimization events.
 *
 * @param {Array<object>} requests recorded requests
 * @returns {Array<object>} events
 */
function collectEvents (requests) {
  const events = []

  for (const request of requests) {
    const requestEvents = request.payload?.events
    if (!Array.isArray(requestEvents)) continue

    const metadata = getMetadata(request.payload?.metadata)

    for (const event of requestEvents) {
      events.push(mergeEventMetadata(event, metadata))
    }
  }

  return events
}

/**
 * Gets metadata groups from a citestcycle payload.
 *
 * @param {unknown} metadata payload metadata
 * @returns {object} metadata groups
 */
function getMetadata (metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {}

  return metadata
}

/**
 * Merges request-level metadata onto an event while preserving event-specific tags.
 *
 * @param {object} event decoded event
 * @param {object} metadata payload metadata groups
 * @returns {object} event with merged metadata
 */
function mergeEventMetadata (event, metadata) {
  const wildcardMetadata = getMetadataGroup(metadata['*'])
  const eventMetadata = getMetadataGroup(metadata[event.type])

  if (Object.keys(wildcardMetadata).length === 0 && Object.keys(eventMetadata).length === 0) {
    return event
  }

  const content = event.content || {}
  const contentMetadata = getMetadataGroup(content.meta)

  return {
    ...event,
    content: {
      ...content,
      meta: {
        ...wildcardMetadata,
        ...eventMetadata,
        ...contentMetadata,
      },
    },
  }
}

/**
 * Gets one payload metadata group.
 *
 * @param {unknown} value metadata group
 * @returns {object} metadata tags
 */
function getMetadataGroup (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  return value
}

/**
 * Gets one compact sample for each basic Test Optimization event level.
 *
 * @param {Array<object>} events decoded events
 * @returns {Array<object>} event samples
 */
function getBasicEventSamples (events) {
  const samples = []
  const seen = new Set()

  for (const event of events) {
    if (!BASIC_EVENT_LEVELS[event.type] || seen.has(event.type)) continue

    samples.push(getBasicEventSample(event))
    seen.add(event.type)

    if (seen.size === Object.keys(BASIC_EVENT_LEVELS).length) break
  }

  return samples
}

/**
 * Gets a compact sample for one basic event level.
 *
 * @param {object} event decoded event
 * @returns {object} compact event sample
 */
function getBasicEventSample (event) {
  const content = event.content || {}
  const meta = content.meta || {}
  const sample = {
    level: BASIC_EVENT_LEVELS[event.type],
  }

  if (event.type === 'test_session_end' || event.type === 'test_module_end') {
    addSampleField(sample, TEST_COMMAND, meta[TEST_COMMAND])
  } else if (event.type === 'test_suite_end') {
    addSampleField(sample, TEST_SUITE, meta[TEST_SUITE] || content.resource || content.name)
  } else if (event.type === 'test') {
    addSampleField(sample, TEST_NAME, meta[TEST_NAME] || content.name || content.resource)
  }

  return sample
}

/**
 * Gets compact samples that prove Early Flake Detection marked and retried new tests.
 *
 * @param {Array<object>} events decoded events
 * @returns {Array<object>} EFD samples
 */
function getEfdSamples (events) {
  const samples = []
  const seen = new Set()

  for (const event of events) {
    if (event.type !== 'test') continue

    const meta = event.content?.meta || {}
    if (meta[TEST_IS_NEW] !== 'true') continue

    const sample = getTestFeatureSample(event)
    sample[TEST_IS_NEW] = true

    if (meta[TEST_IS_RETRY] === 'true') {
      sample[TEST_IS_RETRY] = true
      addSampleField(sample, TEST_RETRY_REASON, meta[TEST_RETRY_REASON])
    }

    addUniqueSample(samples, seen, sample)
    if (samples.length >= FEATURE_SAMPLE_LIMIT) break
  }

  return samples
}

/**
 * Gets compact samples that prove Auto Test Retries observed a failure and retry.
 *
 * @param {Array<object>} events decoded events
 * @returns {Array<object>} Auto Test Retries samples
 */
function getAutoTestRetriesSamples (events) {
  const samples = []
  const seen = new Set()

  for (const event of events) {
    if (event.type !== 'test') continue

    const meta = event.content?.meta || {}
    const isAutoRetry = meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_AUTO_TEST_RETRY
    if (meta[TEST_STATUS] !== 'fail' && !isAutoRetry) continue
    if (meta[TEST_IS_NEW] === 'true') continue

    const sample = getTestFeatureSample(event)
    addSampleField(sample, TEST_STATUS, meta[TEST_STATUS])

    if (meta[TEST_IS_RETRY] === 'true') {
      sample[TEST_IS_RETRY] = true
    }

    addSampleField(sample, TEST_RETRY_REASON, meta[TEST_RETRY_REASON])
    addUniqueSample(samples, seen, sample)
    if (samples.length >= FEATURE_SAMPLE_LIMIT) break
  }

  return samples
}

/**
 * Gets compact samples that prove Test Management tags reached test events.
 *
 * @param {Array<object>} tests managed test observations
 * @returns {Array<object>} Test Management samples
 */
function getTestManagementSamples (tests) {
  const samples = []
  const seen = new Set()

  for (const test of tests) {
    const sample = {}

    addSampleField(sample, TEST_NAME, test.name)
    addSampleField(sample, TEST_STATUS, test.status)
    addSampleField(sample, TEST_FINAL_STATUS, test.finalStatus)

    if (test.isRetry) {
      sample[TEST_IS_RETRY] = true
    }

    addSampleField(sample, TEST_RETRY_REASON, test.retryReason)

    if (test.isDisabled) {
      sample[TEST_MANAGEMENT_IS_DISABLED] = true
    }

    if (test.isQuarantined) {
      sample[TEST_MANAGEMENT_IS_QUARANTINED] = true
    }

    if (test.isAttemptToFix) {
      sample[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX] = true
    }

    addSampleField(sample, TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED, getBooleanTag(test.attemptToFixPassed))
    addUniqueSample(samples, seen, sample)
    if (samples.length >= FEATURE_SAMPLE_LIMIT) break
  }

  return samples
}

/**
 * Gets identifying fields shared by feature samples.
 *
 * @param {object} event decoded test event
 * @returns {object} compact test sample
 */
function getTestFeatureSample (event) {
  const sample = {}
  const test = getTestIdentity(event)

  addSampleField(sample, TEST_NAME, test.name)

  return sample
}

/**
 * Adds a field to a compact sample if it has a meaningful value.
 *
 * @param {object} sample sample to mutate
 * @param {string} key field name
 * @param {unknown} value field value
 */
function addSampleField (sample, key, value) {
  if (value === undefined || value === null || value === '') return

  sample[key] = value
}

/**
 * Adds a unique sample to a bounded list.
 *
 * @param {Array<object>} samples collected samples
 * @param {Set<string>} seen serialized sample keys
 * @param {object} sample sample to append
 */
function addUniqueSample (samples, seen, sample) {
  const key = JSON.stringify(sample)
  if (seen.has(key)) return

  seen.add(key)
  samples.push(sample)
}

/**
 * Converts string boolean tags into booleans for validation UI samples.
 *
 * @param {unknown} value tag value
 * @returns {boolean|undefined} boolean value
 */
function getBooleanTag (value) {
  if (value === 'true') return true
  if (value === 'false') return false
}

/**
 * Gets tests marked as new.
 *
 * @param {Array<object>} events decoded events
 * @returns {Array<object>} test identities
 */
function getNewTests (events) {
  const tests = []

  for (const event of events) {
    if (event.type !== 'test') continue
    if (event.content?.meta?.[TEST_IS_NEW] !== 'true') continue

    tests.push(getTestIdentity(event))
  }

  return tests
}

/**
 * Gets retried tests marked as new.
 *
 * @param {Array<object>} events decoded events
 * @returns {Array<object>} test identities
 */
function getRetriedNewTests (events) {
  const tests = []

  for (const event of events) {
    if (event.type !== 'test') continue

    const meta = event.content?.meta || {}
    if (meta[TEST_IS_NEW] !== 'true') continue
    if (meta[TEST_IS_RETRY] !== 'true' && meta[TEST_RETRY_REASON] !== TEST_RETRY_REASON_EARLY_FLAKE_DETECTION) {
      continue
    }

    tests.push(getTestIdentity(event))
  }

  return tests
}

/**
 * Gets Auto Test Retries summary fields.
 *
 * @param {Array<object>} events decoded events
 * @param {object} settings settings summary
 * @returns {object} Auto Test Retries summary
 */
function getAutoTestRetriesSummary (events, settings) {
  const testGroups = getAutoRetryTestGroups(events)
  const failedThenPassedRetryNames = []
  const passedRetryNames = []
  let failedExecutions = 0
  let passedExecutions = 0
  let passedRetryTests = 0
  let retriedTests = 0

  for (const group of testGroups.values()) {
    if (group.failedExecutions > 0 && group.passedRetryTests > 0) {
      failedThenPassedRetryNames.push(group.name)
    }

    if (group.passedRetryTests > 0) {
      passedRetryNames.push(group.name)
    }

    failedExecutions += group.failedExecutions
    passedExecutions += group.passedExecutions
    passedRetryTests += group.passedRetryTests
    retriedTests += group.retriedTests
  }

  return {
    settingsEnabled: !!settings.lastResponse?.flaky_test_retries_enabled,
    failedExecutions,
    passedExecutions,
    retriedTests,
    retriedTestNames: getSortedValues([...testGroups.values()]
      .filter(group => group.retriedTests > 0)
      .map(group => group.name)),
    passedRetryTests,
    passedRetryTestNames: getSortedValues(passedRetryNames),
    failedThenPassedRetryTests: failedThenPassedRetryNames.length,
    failedThenPassedRetryTestNames: getSortedValues(failedThenPassedRetryNames),
    samples: getAutoTestRetriesSamples(events),
  }
}

/**
 * Groups test events relevant to Auto Test Retries by identity.
 *
 * @param {Array<object>} events decoded events
 * @returns {Map<string, object>} grouped tests
 */
function getAutoRetryTestGroups (events) {
  const groups = new Map()

  for (const event of events) {
    if (event.type !== 'test') continue

    const meta = event.content?.meta || {}
    const retryReason = meta[TEST_RETRY_REASON]
    const status = meta[TEST_STATUS]
    const isAutoRetry = retryReason === TEST_RETRY_REASON_AUTO_TEST_RETRY
    const isPassedRetry = status === 'pass' && meta[TEST_IS_RETRY] === 'true' && isAutoRetry

    if (status !== 'fail' && !isAutoRetry && !isPassedRetry) continue
    if (meta[TEST_IS_NEW] === 'true') continue

    const test = getTestIdentity(event)
    const key = `${test.framework}\0${test.suite}\0${test.name || ''}`
    const group = groups.get(key) || {
      name: test.name,
      failedExecutions: 0,
      passedExecutions: 0,
      passedRetryTests: 0,
      retriedTests: 0,
    }

    if (status === 'fail') {
      group.failedExecutions++
    } else if (status === 'pass') {
      group.passedExecutions++
    }

    if (isAutoRetry) {
      group.retriedTests++
    }

    if (isPassedRetry) {
      group.passedRetryTests++
    }

    groups.set(key, group)
  }

  return groups
}

/**
 * Gets Test Management summary fields.
 *
 * @param {object} artifact fake intake artifact
 * @param {Array<object>} events decoded events
 * @param {object} settings settings summary
 * @param {object} endpointCounts endpoint counts
 * @param {string|undefined} settingsMode fake settings mode
 * @returns {object} Test Management summary
 */
function getTestManagementSummary (artifact, events, settings, endpointCounts, settingsMode) {
  const properties = getReturnedTestManagementProperties(artifact)
  const managedTests = getManagedTestManagementTests(events)
  const matchedPropertyKeys = getMatchedPropertyKeys(properties, managedTests)
  const unmatchedPropertyIdentities = properties
    .filter(property => !matchedPropertyKeys.has(getIdentityKey(property)))
    .map(formatIdentity)

  return {
    settingsEnabled: !!settings.lastResponse?.test_management?.enabled,
    propertiesEndpointCalled: (endpointCounts.test_management || 0) > 0,
    requested: (endpointCounts.test_management || 0) > 0,
    requestCount: endpointCounts.test_management || 0,
    returnedProperties: properties.length,
    returnedPropertyIdentities: properties.map(formatIdentity),
    matchedPropertyIdentities: properties
      .filter(property => matchedPropertyKeys.has(getIdentityKey(property)))
      .map(formatIdentity)
      .sort(),
    unmatchedPropertyIdentities,
    managedTests: {
      count: managedTests.length,
      identities: getSortedValues(managedTests.map(formatIdentity)),
      samples: getTestManagementSamples(managedTests),
    },
    disabled: getDisabledTestManagementSummary(managedTests),
    quarantined: getQuarantinedTestManagementSummary(managedTests),
    attemptToFix: getAttemptToFixTestManagementSummary(managedTests),
    expectedSubcheck: getExpectedTestManagementSubcheck(settingsMode),
  }
}

/**
 * Gets the Test Management subcheck expected for a settings mode.
 *
 * @param {string|undefined} settingsMode fake settings mode
 * @returns {string|undefined} subcheck name
 */
function getExpectedTestManagementSubcheck (settingsMode) {
  if (settingsMode === 'tm-disabled') return 'disabled'
  if (settingsMode === 'tm-quarantined') return 'quarantined'
  if (settingsMode === 'tm-attempt-to-fix' || settingsMode === 'tm-attempt-to-fix-priority') {
    return 'attemptToFix'
  }
}

/**
 * Gets returned Test Management properties from the fake-intake artifact.
 *
 * @param {object} artifact fake intake artifact
 * @returns {Array<object>} returned property entries
 */
function getReturnedTestManagementProperties (artifact) {
  const responses = Array.isArray(artifact?.testManagement?.responses) ? artifact.testManagement.responses : []
  const properties = []

  for (const item of responses) {
    const modules = item?.response?.data?.attributes?.modules ||
      item?.data?.attributes?.modules ||
      item?.modules

    collectTestManagementProperties(modules, properties)
  }

  return properties
}

/**
 * Flattens Test Management modules into identity/property entries.
 *
 * @param {unknown} modules Test Management modules object
 * @param {Array<object>} properties mutable property list
 */
function collectTestManagementProperties (modules, properties) {
  if (!modules || typeof modules !== 'object') return

  for (const [framework, testModule] of Object.entries(modules)) {
    const suites = testModule?.suites
    if (!suites || typeof suites !== 'object') continue

    for (const [suite, suiteValue] of Object.entries(suites)) {
      const tests = suiteValue?.tests
      if (!tests || typeof tests !== 'object') continue

      for (const [name, testValue] of Object.entries(tests)) {
        properties.push({
          framework,
          suite,
          name,
          properties: testValue?.properties || {},
        })
      }
    }
  }
}

/**
 * Gets decoded test events carrying Test Management tags.
 *
 * @param {Array<object>} events decoded events
 * @returns {Array<object>} managed test observations
 */
function getManagedTestManagementTests (events) {
  const tests = []

  for (const event of events) {
    if (event.type !== 'test') continue

    const meta = event.content?.meta || {}
    const isDisabled = meta[TEST_MANAGEMENT_IS_DISABLED] === 'true'
    const isQuarantined = meta[TEST_MANAGEMENT_IS_QUARANTINED] === 'true'
    const isAttemptToFix = meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX] === 'true'

    if (!isDisabled && !isQuarantined && !isAttemptToFix) continue

    tests.push({
      ...getTestIdentity(event),
      status: meta[TEST_STATUS],
      finalStatus: meta[TEST_FINAL_STATUS],
      retryReason: meta[TEST_RETRY_REASON],
      isRetry: meta[TEST_IS_RETRY] === 'true',
      isDisabled,
      isQuarantined,
      isAttemptToFix,
      attemptToFixPassed: meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED],
    })
  }

  return tests
}

/**
 * Gets property identities that matched managed test events.
 *
 * @param {Array<object>} properties returned Test Management properties
 * @param {Array<object>} managedTests managed test observations
 * @returns {Set<string>} matched formatted identities
 */
function getMatchedPropertyKeys (properties, managedTests) {
  const managedKeys = new Set(managedTests.map(getIdentityKey))
  const matched = new Set()

  for (const property of properties) {
    const key = getIdentityKey(property)
    if (managedKeys.has(key)) {
      matched.add(key)
    }
  }

  return matched
}

/**
 * Gets disabled-test Test Management evidence.
 *
 * @param {Array<object>} managedTests managed test observations
 * @returns {object} disabled summary
 */
function getDisabledTestManagementSummary (managedTests) {
  const tests = managedTests.filter(test => test.isDisabled)
  const skipped = tests.filter(test => test.status === 'skip' || test.finalStatus === 'skip').length
  const failed = tests.filter(test => test.status === 'fail' || test.finalStatus === 'fail').length
  const passed = tests.length > 0 && skipped > 0 && failed === 0

  return {
    status: getSubcheckStatus(passed, tests.length),
    reason: passed
      ? 'disabled test was reported as skipped and did not report a failing final status'
      : getMissingManagedTestReason('disabled', tests.length),
    tests: tests.length,
    skipped,
    failed,
    identities: getSortedValues(tests.map(formatIdentity)),
    observedStatuses: getSortedValues(tests.map(test => test.status)),
    observedFinalStatuses: getSortedValues(tests.map(test => test.finalStatus)),
    observedRetryReasons: getSortedValues(tests.map(test => test.retryReason)),
    samples: getTestManagementSamples(tests),
  }
}

/**
 * Gets quarantined-test Test Management evidence.
 *
 * @param {Array<object>} managedTests managed test observations
 * @returns {object} quarantined summary
 */
function getQuarantinedTestManagementSummary (managedTests) {
  const tests = managedTests.filter(test => test.isQuarantined)
  const failed = tests.filter(test => test.status === 'fail').length
  const finalSkipped = tests.filter(test => test.finalStatus === 'skip').length
  const passed = tests.length > 0 && failed > 0 && finalSkipped > 0

  return {
    status: getSubcheckStatus(passed, tests.length),
    reason: passed
      ? 'quarantined test reported a failing execution with final_status=skip'
      : getMissingManagedTestReason('quarantined', tests.length),
    tests: tests.length,
    failed,
    finalSkipped,
    identities: getSortedValues(tests.map(formatIdentity)),
    observedStatuses: getSortedValues(tests.map(test => test.status)),
    observedFinalStatuses: getSortedValues(tests.map(test => test.finalStatus)),
    observedRetryReasons: getSortedValues(tests.map(test => test.retryReason)),
    samples: getTestManagementSamples(tests),
  }
}

/**
 * Gets attempt-to-fix Test Management evidence.
 *
 * @param {Array<object>} managedTests managed test observations
 * @returns {object} attempt-to-fix summary
 */
function getAttemptToFixTestManagementSummary (managedTests) {
  const tests = managedTests.filter(test => test.isAttemptToFix)
  const retryReasons = tests.map(test => test.retryReason).filter(Boolean)
  const badRetryReasons = retryReasons.filter(reason =>
    reason === TEST_RETRY_REASON_AUTO_TEST_RETRY || reason === TEST_RETRY_REASON_EARLY_FLAKE_DETECTION
  )
  const attemptToFixRetries = tests.filter(test =>
    test.isRetry && test.retryReason === TEST_RETRY_REASON_ATTEMPT_TO_FIX
  ).length
  const passedExecutions = tests.filter(test => test.status === 'pass').length
  const failedExecutions = tests.filter(test => test.status === 'fail').length
  const finalFailed = tests.filter(test => test.finalStatus === 'fail').length
  const passed = tests.length > 1 &&
    attemptToFixRetries > 0 &&
    badRetryReasons.length === 0 &&
    passedExecutions > 0 &&
    failedExecutions > 0 &&
    finalFailed > 0

  return {
    status: getSubcheckStatus(passed, tests.length),
    reason: passed
      ? 'attempt-to-fix test retried with retry_reason=attempt_to_fix and ended with final_status=fail'
      : getAttemptToFixFailureReason(
        tests.length,
        attemptToFixRetries,
        badRetryReasons,
        passedExecutions,
        failedExecutions
      ),
    tests: tests.length,
    retryExecutions: tests.filter(test => test.isRetry).length,
    attemptToFixRetryExecutions: attemptToFixRetries,
    badRetryReasons: getSortedValues(badRetryReasons),
    passedExecutions,
    failedExecutions,
    finalFailed,
    identities: getSortedValues(tests.map(formatIdentity)),
    observedStatuses: getSortedValues(tests.map(test => test.status)),
    observedFinalStatuses: getSortedValues(tests.map(test => test.finalStatus)),
    observedRetryReasons: getSortedValues(retryReasons),
    attemptToFixPassedValues: getSortedValues(tests.map(test => test.attemptToFixPassed)),
    samples: getTestManagementSamples(tests),
  }
}

/**
 * Gets a normalized subcheck status.
 *
 * @param {boolean} passed whether the subcheck passed
 * @param {number} count number of managed observations
 * @returns {string} status
 */
function getSubcheckStatus (passed, count) {
  if (passed) return 'passed'
  if (count === 0) return 'not run'

  return 'failed'
}

/**
 * Gets a standard failure reason for missing managed test observations.
 *
 * @param {string} kind subcheck kind
 * @param {number} count observed managed test count
 * @returns {string} reason
 */
function getMissingManagedTestReason (kind, count) {
  if (count === 0) return `no ${kind} managed test span was observed`

  return `${kind} managed test spans did not match the expected status/final_status evidence`
}

/**
 * Gets an attempt-to-fix failure reason.
 *
 * @param {number} count observed attempt-to-fix event count
 * @param {number} attemptToFixRetries attempt-to-fix retry event count
 * @param {string[]} badRetryReasons retry reasons that should not appear
 * @param {number} passedExecutions passed execution count
 * @param {number} failedExecutions failed execution count
 * @returns {string} reason
 */
function getAttemptToFixFailureReason (
  count,
  attemptToFixRetries,
  badRetryReasons,
  passedExecutions,
  failedExecutions
) {
  if (count === 0) return 'no attempt-to-fix managed test span was observed'
  if (attemptToFixRetries === 0) return 'no retry span used test.retry_reason=attempt_to_fix'
  if (badRetryReasons.length > 0) return `unexpected retry reasons were observed: ${badRetryReasons.join(', ')}`
  if (passedExecutions === 0 || failedExecutions === 0) {
    return 'attempt-to-fix did not report both a passing and a failing execution'
  }

  return 'attempt-to-fix managed test spans did not end with final_status=fail'
}

/**
 * Gets an identity key for exact property/event matching.
 *
 * @param {object} identity test identity
 * @returns {string} identity key
 */
function getIdentityKey (identity) {
  return `${identity.framework || 'unknown'}\0${identity.suite || 'unknown'}\0${identity.name || ''}`
}

/**
 * Formats a test identity for reports.
 *
 * @param {object} identity test identity
 * @returns {string} formatted identity
 */
function formatIdentity (identity) {
  const parts = [
    identity.framework || 'unknown',
    identity.suite || 'unknown',
    identity.name || 'unknown',
  ]

  if (identity.parameters) {
    parts.push(`parameters=${identity.parameters}`)
  }

  return parts.join(' | ')
}

/**
 * Gets sorted unique string values.
 *
 * @param {string[]} values values to normalize
 * @returns {string[]} sorted unique values
 */
function getSortedValues (values) {
  return [...new Set(values.filter(Boolean))].sort()
}

/**
 * Gets stable identifying fields for a test event.
 *
 * @param {object} event decoded test event
 * @returns {object} test identity
 */
function getTestIdentity (event) {
  const content = event.content || {}
  const meta = content.meta || {}

  return {
    framework: meta[TEST_FRAMEWORK] || 'unknown',
    module: meta[TEST_MODULE],
    parameters: meta[TEST_PARAMETERS],
    suite: meta[TEST_SUITE] || meta['test.source.file'] || content.resource || 'unknown',
    name: meta[TEST_NAME] || content.name || content.resource,
  }
}

/**
 * Finds missing git fields from the settings request payload.
 *
 * @param {Array<object>} requests recorded requests
 * @returns {object} metadata summary
 */
function getMetadataSummary (requests) {
  const settingsRequest = requests.find(request => request.category === 'settings' && request.payload)
  const attributes = settingsRequest?.payload?.data?.attributes || {}
  const emptyFields = []

  for (const [publicName, intakeName] of GIT_METADATA_FIELDS) {
    if (!attributes[intakeName]) {
      emptyFields.push(publicName)
    }
  }

  return {
    repositoryUrl: attributes.repository_url,
    commitSha: attributes.sha,
    branch: attributes.branch,
    emptyFields,
  }
}

/**
 * Finds settings requests and the settings response returned by the fake intake.
 *
 * @param {object} artifact fake intake artifact
 * @param {Array<object>} requests recorded requests
 * @returns {object} settings summary
 */
function getSettingsSummary (artifact, requests) {
  const responses = Array.isArray(artifact?.settings?.responses) ? artifact.settings.responses : []

  return {
    requestCount: requests.filter(request => request.category === 'settings').length,
    lastResponse: responses[responses.length - 1],
  }
}

/**
 * Counts known tests returned by the fake intake.
 *
 * @param {object} artifact fake intake artifact
 * @returns {number} known test count
 */
function getKnownTestsReceived (artifact) {
  const responses = Array.isArray(artifact?.knownTests?.responses) ? artifact.knownTests.responses : []
  const lastResponse = responses[responses.length - 1]
  const tests = lastResponse?.data?.attributes?.tests

  return countKnownTests(tests)
}

/**
 * Counts known tests in nested known-tests response data.
 *
 * @param {unknown} value known tests value
 * @returns {number} known test count
 */
function countKnownTests (value) {
  if (Array.isArray(value)) return value.length
  if (!value || typeof value !== 'object') return 0

  let count = 0
  for (const child of Object.values(value)) {
    count += countKnownTests(child)
  }
  return count
}

/**
 * Gets expected test event levels that were not observed.
 *
 * @param {object} eventCounts counts by event type
 * @returns {Array<string>} missing event levels
 */
function getMissingEventLevels (eventCounts) {
  const expectedEvents = ['test_session_end', 'test_module_end', 'test_suite_end', 'test']
  const missingEvents = []

  for (const eventName of expectedEvents) {
    if (!eventCounts[eventName]) {
      missingEvents.push(eventName)
    }
  }

  return missingEvents
}

/**
 * Counts test events not linked to an observed test session id.
 *
 * @param {Array<object>} events decoded events
 * @returns {number} unlinked test span count
 */
function countUnlinkedTestSpans (events) {
  const sessionIds = new Set()

  for (const event of events) {
    if (event.type !== 'test_session_end') continue

    const sessionId = normalizeId(event.content?.test_session_id)
    if (sessionId) {
      sessionIds.add(sessionId)
    }
  }

  if (sessionIds.size === 0) return 0

  let unlinked = 0
  for (const event of events) {
    if (event.type !== 'test') continue

    const sessionId = normalizeId(event.content?.test_session_id || event.content?.meta?.test_session_id)
    if (!sessionId || !sessionIds.has(sessionId)) {
      unlinked++
    }
  }

  return unlinked
}

/**
 * Normalizes numeric ids for comparison.
 *
 * @param {unknown} value id value
 * @returns {string|undefined} normalized id
 */
function normalizeId (value) {
  if (value === undefined || value === null || value === '') return
  return String(value)
}

/**
 * Collects decode errors from recorded requests.
 *
 * @param {Array<object>} requests recorded requests
 * @returns {Array<object>} decode errors
 */
function getDecodeErrors (requests) {
  const errors = []

  for (const request of requests) {
    if (!request.decodeError) continue

    errors.push({
      path: request.path,
      error: request.decodeError,
    })
  }

  return errors
}

module.exports = {
  analyzeIntakeArtifact,
  buildKnownTestsFromArtifact,
  buildTestManagementTestsFromArtifact,
  renderAnalysisText,
  summarizeIntakeArtifact,
}
