'use strict'

const path = require('node:path')
const { pathToFileURL } = require('node:url')

const GIT_METADATA_FIELDS = [
  ['repositoryUrl', 'repository_url'],
  ['commitSha', 'sha'],
  ['branch', 'branch'],
]

/**
 * Builds a fixed-rule diagnosis from a fake intake artifact.
 *
 * @param {object} artifact fake intake artifact
 * @returns {object} analysis report
 */
function analyzeIntakeArtifact (artifact) {
  const summary = summarizeIntakeArtifact(artifact)
  const findings = []
  const advancedFeatureChecks = artifact?.intake?.settingsMode === 'debug-all'

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

  if (advancedFeatureChecks && summary.coverage.expected && summary.coverage.citestcov === 0) {
    addFinding(findings, 'warning', 'Coverage missing', {
      observation: 'ITR or coverage was enabled, but citestcov: 0',
      cause: 'Coverage collection did not run or could not upload coverage payloads.',
      fix:
        'Check framework coverage support, coverage configuration, and whether the selected subset can produce ' +
        'coverage.',
    })
  }

  if (!findings.some(finding => finding.status === 'error') && summary.events.missingLevels.length === 0) {
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
      total: events.length,
      unlinkedTestSpans: countUnlinkedTestSpans(events),
    },
    efd: {
      settingsEnabled: efdSettingsEnabled,
      requested: (endpointCounts.known_tests || 0) > 0,
      knownTestsReceived,
    },
    coverage: {
      expected: !!(settings.lastResponse?.itr_enabled || settings.lastResponse?.code_coverage),
      citestcov: endpointCounts.citestcov || 0,
      coverageReport: endpointCounts.cicovreprt || 0,
    },
    decodeErrors: getDecodeErrors(requests),
  }
}

/**
 * Formats an intake analysis as plain text.
 *
 * @param {object} analysis analysis report
 * @returns {string} human-readable report
 */
function renderAnalysisText (analysis) {
  const lines = [
    `HTML report: ${getHtmlReportReference(analysis)}`,
    `HTML report path: ${analysis.summary.artifacts.htmlPath || 'not available'}`,
    `Open HTML report command: ${analysis.summary.artifacts.htmlOpenCommand || 'not available'}`,
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

    for (const event of requestEvents) {
      events.push(event)
    }
  }

  return events
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

  if (Array.isArray(tests)) return tests.length
  if (!tests || typeof tests !== 'object') return 0

  let count = 0
  for (const value of Object.values(tests)) {
    if (Array.isArray(value)) {
      count += value.length
    }
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
  renderAnalysisText,
  summarizeIntakeArtifact,
}
