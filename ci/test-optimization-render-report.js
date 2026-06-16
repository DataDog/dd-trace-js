#!/usr/bin/env node
'use strict'

/* eslint-disable no-console, eslint-rules/eslint-process-env */

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const {
  analyzeIntakeArtifact,
} = require('./test-optimization-intake-analysis')
const {
  buildValidationPayload,
  getBasicReportingFailureCause,
  getValidationAppUrl,
} = require('./test-optimization-validation-link')

const DEFAULT_ENV_KEYS = [
  'DD_API_KEY',
  'DD_SERVICE',
  'DD_CIVISIBILITY_AGENTLESS_ENABLED',
  'DD_CIVISIBILITY_AGENTLESS_URL',
  'DD_INSTRUMENTATION_TELEMETRY_ENABLED',
  'NODE_OPTIONS',
]

/**
 * Parses CLI arguments.
 *
 * @param {string[]} args command-line arguments
 * @returns {object} parsed options
 */
function parseArgs (args) {
  const options = {
    env: [],
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--static') {
      options.static = args[++i]
    } else if (arg.startsWith('--static=')) {
      options.static = arg.slice('--static='.length)
    } else if (arg === '--intake') {
      options.intake = args[++i]
    } else if (arg.startsWith('--intake=')) {
      options.intake = arg.slice('--intake='.length)
    } else if (arg === '--test-command') {
      options.testCommand = args[++i]
    } else if (arg.startsWith('--test-command=')) {
      options.testCommand = arg.slice('--test-command='.length)
    } else if (arg === '--test-command-file') {
      options.testCommandFile = args[++i]
    } else if (arg.startsWith('--test-command-file=')) {
      options.testCommandFile = arg.slice('--test-command-file='.length)
    } else if (arg === '--test-exit-code') {
      options.testExitCode = args[++i]
    } else if (arg.startsWith('--test-exit-code=')) {
      options.testExitCode = arg.slice('--test-exit-code='.length)
    } else if (arg === '--test-exit-code-file') {
      options.testExitCodeFile = args[++i]
    } else if (arg.startsWith('--test-exit-code-file=')) {
      options.testExitCodeFile = arg.slice('--test-exit-code-file='.length)
    } else if (arg === '--test-result') {
      options.testResult = args[++i]
    } else if (arg.startsWith('--test-result=')) {
      options.testResult = arg.slice('--test-result='.length)
    } else if (arg === '--test-result-file') {
      options.testResultFile = args[++i]
    } else if (arg.startsWith('--test-result-file=')) {
      options.testResultFile = arg.slice('--test-result-file='.length)
    } else if (arg === '--test-output-file') {
      options.testOutputFile = args[++i]
    } else if (arg.startsWith('--test-output-file=')) {
      options.testOutputFile = arg.slice('--test-output-file='.length)
    } else if (arg === '--new-test-file') {
      options.newTestFile = args[++i]
    } else if (arg.startsWith('--new-test-file=')) {
      options.newTestFile = arg.slice('--new-test-file='.length)
    } else if (arg === '--new-test-snippet') {
      options.newTestSnippet = args[++i]
    } else if (arg.startsWith('--new-test-snippet=')) {
      options.newTestSnippet = arg.slice('--new-test-snippet='.length)
    } else if (arg === '--new-test-snippet-file') {
      options.newTestSnippetFile = args[++i]
    } else if (arg.startsWith('--new-test-snippet-file=')) {
      options.newTestSnippetFile = arg.slice('--new-test-snippet-file='.length)
    } else if (arg === '--flaky-test-snippet') {
      options.flakyTestSnippet = args[++i]
    } else if (arg.startsWith('--flaky-test-snippet=')) {
      options.flakyTestSnippet = arg.slice('--flaky-test-snippet='.length)
    } else if (arg === '--flaky-test-snippet-file') {
      options.flakyTestSnippetFile = args[++i]
    } else if (arg.startsWith('--flaky-test-snippet-file=')) {
      options.flakyTestSnippetFile = arg.slice('--flaky-test-snippet-file='.length)
    } else if (arg === '--env') {
      options.env.push(args[++i])
    } else if (arg.startsWith('--env=')) {
      options.env.push(arg.slice('--env='.length))
    } else if (arg === '--env-file') {
      options.envFile = args[++i]
    } else if (arg.startsWith('--env-file=')) {
      options.envFile = arg.slice('--env-file='.length)
    } else if (arg === '--agent-report') {
      options.agentReport = args[++i]
    } else if (arg.startsWith('--agent-report=')) {
      options.agentReport = arg.slice('--agent-report='.length)
    } else if (arg === '--agent-json-report') {
      options.agentJsonReport = args[++i]
    } else if (arg.startsWith('--agent-json-report=')) {
      options.agentJsonReport = arg.slice('--agent-json-report='.length)
    } else if (arg === '--html') {
      options.html = args[++i]
    } else if (arg.startsWith('--html=')) {
      options.html = arg.slice('--html='.length)
    } else if (arg === '--out') {
      options.out = args[++i]
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length)
    } else if (arg === '--summary-out') {
      options.summaryOut = args[++i]
    } else if (arg.startsWith('--summary-out=')) {
      options.summaryOut = arg.slice('--summary-out='.length)
    } else if (arg === '--feedback-summary-out') {
      options.feedbackSummaryOut = args[++i]
    } else if (arg.startsWith('--feedback-summary-out=')) {
      options.feedbackSummaryOut = arg.slice('--feedback-summary-out='.length)
    } else if (arg === '--feedback') {
      options.feedback = args[++i]
    } else if (arg.startsWith('--feedback=')) {
      options.feedback = arg.slice('--feedback='.length)
    } else if (arg === '--feedback-file') {
      options.feedbackFile = args[++i]
    } else if (arg.startsWith('--feedback-file=')) {
      options.feedbackFile = arg.slice('--feedback-file='.length)
    } else if (arg === '--advanced-agent-json-report') {
      options.advancedAgentJsonReport = args[++i]
    } else if (arg.startsWith('--advanced-agent-json-report=')) {
      options.advancedAgentJsonReport = arg.slice('--advanced-agent-json-report='.length)
    } else if (arg === '--final-report') {
      options.finalReport = args[++i]
    } else if (arg.startsWith('--final-report=')) {
      options.finalReport = arg.slice('--final-report='.length)
    } else if (arg === '--compact-summary') {
      options.compactSummary = args[++i]
    } else if (arg.startsWith('--compact-summary=')) {
      options.compactSummary = arg.slice('--compact-summary='.length)
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      options.unknown = arg
    }
  }

  return options
}

/**
 * Returns CLI help text.
 *
 * @returns {string} help text
 */
function getHelpText () {
  return [
    'Usage: dd-trace-ci-render-report --static <static.json> --intake <intake.json> ' +
      '--test-command <command> --test-exit-code <code> [options]',
    '',
    'Renders the final Test Optimization diagnosis report for a runbook execution.',
    '',
    'Options:',
    '  --test-command-file <file>     Read the exact selected test command from a file.',
    '  --test-exit-code-file <file>   Read the selected test command exit code from a file.',
    '  --test-result <text>           Include a short test runner result summary.',
    '  --test-result-file <file>      Read the short test runner result summary from a file.',
    '  --test-output-file <file>      Read full test runner output for EFD execution diagnostics.',
    '  --new-test-file <file>          Include the temporary EFD test file path.',
    '  --new-test-snippet <text>       Include the temporary test snippet used for EFD.',
    '  --new-test-snippet-file <file>  Read the temporary test snippet used for EFD.',
    '  --flaky-test-snippet <text>     Include the temporary flaky test snippet used for Auto Test Retries.',
    '  --flaky-test-snippet-file <file>  Read the temporary flaky test snippet used for Auto Test Retries.',
    '  --env KEY=value                Include an environment variable used for the live run.',
    '  --env-file <file>              Read environment variables, one KEY=value per line.',
    '  --agent-report <file>          Path to the plain text analyzer artifact.',
    '  --agent-json-report <file>     Path to the JSON analyzer artifact.',
    '  --html <file>                  Override the HTML report path.',
    '  --out <file>                   Write the final report to a file.',
    '  --summary-out <file>           Write a compact summary without long validation paths.',
    '  --feedback-summary-out <file>  Write a compact coding-agent feedback summary.',
    '  --feedback <text>              Actionable feedback text for the feedback summary.',
    '  --feedback-file <file>         Read actionable feedback text for the feedback summary.',
    '  --advanced-agent-json-report <file>  Advanced-check JSON report for the feedback summary.',
    '  --final-report <file>          Final report path for the feedback summary.',
    '  --compact-summary <file>       Compact summary path for the feedback summary.',
  ].join('\n')
}

/**
 * Renders the final report text from files and run metadata.
 *
 * @param {object} options report options
 * @returns {string} final report text
 */
function renderFinalReport (options) {
  validateOptions(options)

  const staticPath = path.resolve(options.static)
  const intakePath = path.resolve(options.intake)
  const staticReport = readJson(staticPath)
  const intakeArtifact = readJson(intakePath)
  const analysis = analyzeIntakeArtifact(intakeArtifact)
  const testCommand = readTextValue(options.testCommand, options.testCommandFile, 'test command')
  const testExitCode = readTextValue(options.testExitCode, options.testExitCodeFile, 'test exit code')
  const testResult = readOptionalTextValue(options.testResult, options.testResultFile)
  const testOutput = readOptionalTextValue(undefined, options.testOutputFile)
  const newTestFile = readOptionalTextValue(options.newTestFile)
  const newTestSnippet = readOptionalTextValue(options.newTestSnippet, options.newTestSnippetFile)
  const flakyTestSnippet = readOptionalTextValue(options.flakyTestSnippet, options.flakyTestSnippetFile)
  const efdExecution = getEfdExecutionDiagnostics(analysis, {
    newTestFile,
    newTestSnippet,
    testCommand,
    testOutput,
  })

  if (efdExecution) analysis.summary.efd.execution = efdExecution

  const env = getEnvList(options, analysis)
  const htmlPath = getHtmlPath(options, analysis)
  const htmlFileUrl = analysis.summary.artifacts.htmlFileUrl || pathToFileURL(htmlPath).href
  const staticHighlights = getStaticHighlights(staticReport)
  const staticErrors = staticHighlights.filter(finding => finding.status === 'error')
  const artifactPaths = getArtifactPaths(options, staticPath, intakePath, htmlPath)
  const likelyFailureCause = getReportingStatus(analysis) === 'OK'
    ? undefined
    : getBasicReportingFailureCause({ staticReport, testCommand }, analysis)
  const validationAppUrl = getValidationAppUrl(buildValidationPayload({
    analysis,
    artifacts: {
      ...artifactPaths,
      htmlFileUrl,
    },
    env,
    flakyTestSnippet,
    newTestSnippet,
    staticReport,
    testCommand,
    testExitCode,
    testResult,
  }))

  const lines = [
    `HTML report: ${htmlFileUrl}`,
    `Datadog validation: ${validationAppUrl}`,
    '',
    `Primary funnel stage: ${analysis.primaryStage}`,
    '',
    'Scope:',
    ...getScopeLines(analysis),
    '',
    'Summary:',
    ...getStageStatusLines(analysis, testExitCode),
    '',
    'Findings:',
  ]

  for (const finding of analysis.findings) {
    lines.push(
      `- ${finding.status}: ${finding.stage} - ${finding.observation}`,
      `  ${finding.cause}`,
      `  ${finding.fix}`
    )
  }

  if (likelyFailureCause) {
    lines.push(`- error: Likely failure cause - ${likelyFailureCause}`)
  }

  lines.push('', 'Static diagnosis highlights:')
  if (staticErrors.length === 0) {
    lines.push('- none')
  } else {
    for (const finding of staticErrors) {
      lines.push(`- ${formatStaticFinding(finding)}`)
    }
  }

  lines.push(
    '',
    'Test command used:',
    testCommand,
    '',
    'What this proves:',
    `- ${getProvesText(analysis, testCommand)}`
  )

  return lines.join('\n')
}

/**
 * Renders a compact report summary for agent responses.
 *
 * @param {object} options report options
 * @returns {string} compact summary text
 */
function renderSummaryReport (options) {
  validateOptions(options)

  const staticPath = path.resolve(options.static)
  const intakePath = path.resolve(options.intake)
  const staticReport = readJson(staticPath)
  const intakeArtifact = readJson(intakePath)
  const analysis = analyzeIntakeArtifact(intakeArtifact)
  const testCommand = readTextValue(options.testCommand, options.testCommandFile, 'test command')
  const testExitCode = readTextValue(options.testExitCode, options.testExitCodeFile, 'test exit code')
  const testOutput = readOptionalTextValue(undefined, options.testOutputFile)
  const newTestFile = readOptionalTextValue(options.newTestFile)
  const newTestSnippet = readOptionalTextValue(options.newTestSnippet, options.newTestSnippetFile)
  const efdExecution = getEfdExecutionDiagnostics(analysis, {
    newTestFile,
    newTestSnippet,
    testCommand,
    testOutput,
  })

  if (efdExecution) analysis.summary.efd.execution = efdExecution

  const htmlPath = getHtmlPath(options, analysis)
  const htmlFileUrl = analysis.summary.artifacts.htmlFileUrl || pathToFileURL(htmlPath).href
  const staticHighlights = getStaticHighlights(staticReport)
  const staticErrors = staticHighlights.filter(finding => finding.status === 'error')
  const likelyFailureCause = getReportingStatus(analysis) === 'OK'
    ? undefined
    : getBasicReportingFailureCause({ staticReport, testCommand }, analysis)
  const lines = [
    'Test Optimization debug summary',
    `HTML report: ${htmlFileUrl}`,
    `Primary funnel stage: ${analysis.primaryStage}`,
    '',
    'Summary:',
    ...getStageStatusLines(analysis, testExitCode),
    '',
    'Findings:',
    ...getSummaryFindingLines(analysis, likelyFailureCause),
    '',
    'Static diagnosis highlights:',
    ...getSummaryStaticLines(staticErrors),
    '',
    'Test command used:',
    testCommand,
    '',
    'What this proves:',
    `- ${getProvesText(analysis, testCommand)}`,
  ]

  return lines.join('\n')
}

/**
 * Renders a compact coding-agent feedback summary.
 *
 * @param {object} options feedback summary options
 * @returns {string} compact feedback summary text
 */
function renderFeedbackSummary (options) {
  const basic = readOptionalJson(options.agentJsonReport || 'dd-test-optimization-agent-report.json', {})
  const advanced = readOptionalJson(
    options.advancedAgentJsonReport ||
      path.join('dd-test-optimization-efd', 'dd-test-optimization-agent-report.json'),
    {}
  )
  const stage = basic.primaryStage || 'unknown'
  const decodeErrors = Array.isArray(basic.summary?.decodeErrors)
    ? basic.summary.decodeErrors.length
    : basic.summary?.decodeErrors || 0
  const eventLevels =
    `sessions=${countEvent(basic, 'test_session_end')}, ` +
    `modules=${countEvent(basic, 'test_module_end')}, ` +
    `suites=${countEvent(basic, 'test_suite_end')}, ` +
    `tests=${countEvent(basic, 'test')}`
  const retriedNewTestNames = advanced.summary?.efd?.retriedNewTestNames || []
  const efdExecution = advanced.summary?.efd?.execution
  const cleanup = [
    fs.existsSync('dd-test-optimization-efd-temp-test-file.txt')
      ? 'temporary EFD cleanup incomplete'
      : 'temporary EFD removed/restored',
    fs.existsSync('dd-test-optimization-atr-flaky-test-file.txt')
      ? 'flaky edit cleanup incomplete'
      : 'flaky edit restored',
  ].join(', ')

  return [
    `Runbook completed: ${getRunbookCompletedStatus(stage)}`,
    `Diagnostic outcome: ${getDiagnosticOutcome(stage)}`,
    `Basic reporting: ${stage}, requests=${basic.summary?.requestCount ?? 'unknown'}, ` +
      `event levels=${eventLevels}, decode errors=${decodeErrors}`,
    `EFD: ${getAdvancedStatus(advanced, 'efd')}, ` +
      `known tests=${advanced.summary?.efd?.knownTestsReceived ?? 'n/a'}, ` +
      `retried new tests=${advanced.summary?.efd?.retriedNewTests ?? 'n/a'}, ` +
      `distinct retried names=${getDistinctCount(retriedNewTestNames)}`,
    `EFD diagnosis: ${efdExecution?.diagnosis || 'n/a'}`,
    `Auto Test Retries: ${getAdvancedStatus(advanced, 'atr')}, ` +
      `failed=${advanced.summary?.atr?.failedExecutions ?? 'n/a'}, ` +
      `passed=${advanced.summary?.atr?.passedExecutions ?? 'n/a'}, ` +
      `retry passes=${advanced.summary?.atr?.passedRetryTests ?? 'n/a'}`,
    `Reports: ${readReportLine(getFinalReportPath(options), 'HTML report:')}, ` +
      `${path.resolve(getFinalReportPath(options))}, ${path.resolve(getCompactSummaryPath(options))}`,
    `Cleanup: ${cleanup}. Diagnostic artifacts intentionally remain untracked until the next Step 0 cleanup.`,
    'Actionable feedback:',
    ...getFeedbackLines(options),
  ].join('\n')
}

/**
 * Reads optional JSON from disk.
 *
 * @param {string} file file path
 * @param {object} fallback fallback value
 * @returns {object} parsed JSON or fallback
 */
function readOptionalJson (file, fallback) {
  try {
    return readJson(file)
  } catch {
    return fallback
  }
}

/**
 * Gets the runbook completion status.
 *
 * @param {string} stage basic primary stage
 * @returns {string} completion status
 */
function getRunbookCompletedStatus (stage) {
  return stage === 'unknown' ? 'no; root analyzer report is missing' : 'yes'
}

/**
 * Gets the diagnostic outcome.
 *
 * @param {string} stage basic primary stage
 * @returns {string} diagnostic outcome
 */
function getDiagnosticOutcome (stage) {
  if (stage === 'Reporting complete') return 'basic reporting worked'
  if (stage === 'unknown') return 'runbook failed; root analyzer report is missing'

  return 'basic reporting did not work'
}

/**
 * Gets a count for a test event level.
 *
 * @param {object} report analyzer JSON report
 * @param {string} eventType test event type
 * @returns {number} event count
 */
function countEvent (report, eventType) {
  return report?.summary?.events?.counts?.[eventType] || 0
}

/**
 * Gets advanced-check status for feedback output.
 *
 * @param {object} report advanced analyzer JSON report
 * @param {string} kind advanced feature kind
 * @returns {string} feature status
 */
function getAdvancedStatus (report, kind) {
  if (!report.primaryStage) return 'not run'
  if (kind === 'efd') return report.summary?.efd?.retriedNewTests > 0 ? 'passed' : 'failed'

  return report.summary?.atr?.failedThenPassedRetryTests > 0 ? 'passed' : 'failed'
}

/**
 * Gets the final report path for feedback output.
 *
 * @param {object} options feedback summary options
 * @returns {string} final report path
 */
function getFinalReportPath (options) {
  return options.finalReport || 'dd-test-optimization-final-report.txt'
}

/**
 * Gets the compact summary path for feedback output.
 *
 * @param {object} options feedback summary options
 * @returns {string} compact summary path
 */
function getCompactSummaryPath (options) {
  return options.compactSummary || 'dd-test-optimization-summary.txt'
}

/**
 * Reads a line from a report.
 *
 * @param {string} file report file
 * @param {string} prefix line prefix
 * @returns {string} line value
 */
function readReportLine (file, prefix) {
  const text = readOptionalTextFile(file)
  const line = text.split(/\r?\n/).find(line => line.startsWith(prefix))

  return line ? line.slice(prefix.length).trim() : 'unknown'
}

/**
 * Reads optional text from a file.
 *
 * @param {string} file file path
 * @returns {string} file text or empty string
 */
function readOptionalTextFile (file) {
  try {
    return fs.readFileSync(path.resolve(file), 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * Gets formatted actionable feedback lines.
 *
 * @param {object} options feedback summary options
 * @returns {string[]} feedback lines
 */
function getFeedbackLines (options) {
  const text = getFeedbackText(options)
  const lines = text.split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

  if (lines.length === 0) return ['- <replace with feedback, or "No actionable feedback.">']

  return lines.map(line => line.startsWith('- ') ? line : `- ${line}`)
}

/**
 * Gets actionable feedback text from CLI options or environment.
 *
 * @param {object} options feedback summary options
 * @returns {string} feedback text
 */
function getFeedbackText (options) {
  if (options.feedback !== undefined) return String(options.feedback).trim()
  if (options.feedbackFile) return readOptionalTextFile(options.feedbackFile)
  if (process.env.DD_TEST_OPTIMIZATION_FEEDBACK) return process.env.DD_TEST_OPTIMIZATION_FEEDBACK.trim()

  return ''
}

/**
 * Gets compact EFD status text.
 *
 * @param {object} analysis intake analysis
 * @returns {string} status text
 */
function getEfdStatus (analysis) {
  if (analysis.summary.efd.retriedNewTests > 0) return 'passed'
  if (analysis.summary.efd.settingsEnabled || analysis.summary.efd.requested) return 'failed'

  return 'not run'
}

/**
 * Gets compact Auto Test Retries status text.
 *
 * @param {object} analysis intake analysis
 * @returns {string} status text
 */
function getAutoTestRetriesStatus (analysis) {
  if (analysis.summary.atr.failedThenPassedRetryTests > 0) return 'passed'
  if (analysis.summary.atr.settingsEnabled || analysis.summary.atr.retriedTests > 0) return 'failed'

  return 'not run'
}

/**
 * Gets concise per-stage status lines for console output.
 *
 * @param {object} analysis intake analysis
 * @param {string} testExitCode selected command exit code
 * @returns {string[]} stage status lines
 */
function getStageStatusLines (analysis, testExitCode) {
  const lines = [
    `- Reporting: ${getReportingStatus(analysis)}`,
  ]
  const efdStatus = getEfdStatus(analysis)
  const atrStatus = getAutoTestRetriesStatus(analysis)
  const tmStatus = getTestManagementStatus(analysis, testExitCode)

  if (efdStatus !== 'not run') lines.push(`- EFD: ${formatStageStatus(efdStatus)}`)
  if (atrStatus !== 'not run') lines.push(`- Auto Test Retries: ${formatStageStatus(atrStatus)}`)
  if (tmStatus !== 'not run') lines.push(`- Test Management: ${formatStageStatus(tmStatus)}`)

  return lines
}

/**
 * Gets concise basic reporting status.
 *
 * @param {object} analysis intake analysis
 * @returns {string} reporting status
 */
function getReportingStatus (analysis) {
  if (
    analysis.primaryStage === 'Reporting complete' ||
    (
      analysis.summary.citestcycle.payloadCount > 0 &&
      analysis.summary.events.missingLevels.length === 0
    )
  ) {
    return 'OK'
  }

  return `failed (${analysis.primaryStage})`
}

/**
 * Formats a compact stage status.
 *
 * @param {string} status raw status
 * @returns {string} formatted status
 */
function formatStageStatus (status) {
  if (status === 'passed') return 'OK'
  if (status === 'failed') return 'failed'
  if (status.startsWith('failed:')) return `failed (${status.slice('failed:'.length).trim()})`

  return status
}

/**
 * Gets compact static finding lines.
 *
 * @param {Array<object>} staticHighlights actionable static findings
 * @returns {string[]} summary finding lines
 */
function getSummaryStaticLines (staticHighlights) {
  if (staticHighlights.length === 0) return ['- none']

  return staticHighlights.map(finding => `- ${finding.status}: ${finding.title}`)
}

/**
 * Gets concise finding lines for summary artifacts.
 *
 * @param {object} analysis intake analysis
 * @param {string|undefined} likelyFailureCause likely failure cause
 * @returns {string[]} finding lines
 */
function getSummaryFindingLines (analysis, likelyFailureCause) {
  const lines = analysis.findings.map(finding => `- ${finding.status}: ${finding.stage} - ${finding.observation}`)

  if (likelyFailureCause) lines.push(`- error: Likely failure cause - ${likelyFailureCause}`)

  return lines.length === 0 ? ['- none'] : lines
}

/**
 * Gets scope lines.
 *
 * @param {object} analysis intake analysis
 * @returns {string[]} scope lines
 */
function getScopeLines (analysis) {
  const lines = [
    '- Selected test subset only.',
    '- Basic reporting: session, module, suite, and test events.',
  ]

  if (analysis.summary.tm.settingsEnabled || analysis.summary.tm.propertiesEndpointCalled) {
    lines.push(
      '- Test Management check: settings, properties, and managed test behavior for one subcheck.',
      '- Does not validate the full Test Management configuration, ITR, test skipping, coverage, or the ' +
        'full CI workflow.'
    )
  } else if (analysis.summary.efd.settingsEnabled) {
    lines.push(
      '- EFD check: known tests endpoint, new-test detection, and retry evidence for the selected subset.',
      '- Auto Test Retries check: failed and passing retry executions for one known flaky test.',
      '- Does not validate ITR, test skipping, test management, coverage, or the full CI workflow.'
    )
  } else {
    lines.push('- Does not validate EFD, ITR, test skipping, test management, coverage, or the full CI workflow.')
  }

  return lines
}

/**
 * Gets EFD execution diagnostics from runner output and generated test metadata.
 *
 * @param {object} analysis intake analysis
 * @param {object} options execution metadata
 * @returns {object|undefined} EFD execution diagnostics
 */
function getEfdExecutionDiagnostics (analysis, options = {}) {
  const efd = analysis.summary?.efd || {}
  if (!efd.settingsEnabled && !efd.requested) return
  if (efd.retriedNewTests > 0) return

  const testCommand = options.testCommand || ''
  const testOutput = options.testOutput || ''
  const newTestFile = options.newTestFile || ''
  const newTestName = getGeneratedTestName(options.newTestSnippet || '')
  const commandIncludesNewTestFile = newTestFile ? testCommand.includes(newTestFile) : undefined
  const outputMentionsNewTestFile = newTestFile ? testOutput.includes(newTestFile) : undefined
  const outputMentionsNewTestName = newTestName ? testOutput.includes(newTestName) : undefined
  let diagnosis

  if (efd.knownTestsReceived === 0) {
    diagnosis = 'known-tests response was empty, so EFD had no baseline for new-test detection.'
  } else if (Array.isArray(efd.newTests) && efd.newTests.length > 0) {
    diagnosis = 'a new test was reported, but no EFD retry event was observed for it.'
  } else if (newTestName && outputMentionsNewTestName === false) {
    diagnosis = 'temporary EFD test did not execute; test runner output does not include the generated test name.'
  } else if (newTestFile && commandIncludesNewTestFile === false) {
    diagnosis = 'temporary EFD test file was not included in the selected EFD command.'
  } else if (testOutput) {
    diagnosis = 'no reported test was marked new; compare the generated test identity with the known-tests response.'
  } else {
    diagnosis = 'test runner output was unavailable; compare the generated test identity with reported test events.'
  }

  return {
    commandIncludesNewTestFile,
    diagnosis,
    newTestFile,
    newTestName,
    outputMentionsNewTestFile,
    outputMentionsNewTestName,
  }
}

/**
 * Extracts the generated test name from a temporary test snippet.
 *
 * @param {string} snippet generated test snippet
 * @returns {string} generated test name
 */
function getGeneratedTestName (snippet) {
  const match = snippet.match(/\b(?:it|test)\(\s*(['"`])(.+?)\1/)
  return match ? match[2] : ''
}

/**
 * Counts distinct values.
 *
 * @param {string[]} values values to count
 * @returns {number} distinct value count
 */
function getDistinctCount (values) {
  return new Set(values || []).size
}

/**
 * Gets compact Test Management status text.
 *
 * @param {object} analysis intake analysis
 * @param {string} testExitCode selected command exit code
 * @returns {string} status text
 */
function getTestManagementStatus (analysis, testExitCode) {
  const tm = analysis.summary.tm
  if (!tm.settingsEnabled && !tm.propertiesEndpointCalled && tm.managedTests.count === 0) return 'not run'

  const expected = tm.expectedSubcheck
  if (expected) {
    const expectedExitCode = expected === 'attemptToFix' ? 'non-zero' : '0'
    return getTestManagementSubcheckStatus(tm[expected], testExitCode, expectedExitCode)
  }

  const statuses = [
    getTestManagementSubcheckStatus(tm.disabled, testExitCode, '0'),
    getTestManagementSubcheckStatus(tm.quarantined, testExitCode, '0'),
    getTestManagementSubcheckStatus(tm.attemptToFix, testExitCode, 'non-zero'),
  ]
  let hasPassed = false
  let hasFailed = false

  for (const status of statuses) {
    if (status === 'passed') hasPassed = true
    if (status.startsWith('failed')) hasFailed = true
  }

  if (hasPassed) return 'passed'
  if (hasFailed) return 'failed'

  return 'not run'
}

/**
 * Gets a Test Management subcheck status with command-exit validation.
 *
 * @param {object} subcheck analyzer subcheck summary
 * @param {string} testExitCode selected command exit code
 * @param {string} expectedExitCode expected command exit code
 * @returns {string} status text
 */
function getTestManagementSubcheckStatus (subcheck, testExitCode, expectedExitCode) {
  if (!subcheck || subcheck.status === 'not run') return 'not run'
  if (subcheck.status !== 'passed') return `failed: ${subcheck.reason}`
  if (testExitCode === undefined) return 'passed; command exit code not recorded'

  const exitCode = String(testExitCode)
  if (expectedExitCode === 'non-zero') {
    return exitCode === '0' ? 'failed: expected non-zero command exit code' : 'passed'
  }

  return exitCode === expectedExitCode ? 'passed' : `failed: expected command exit code ${expectedExitCode}`
}

/**
 * Validates required options.
 *
 * @param {object} options report options
 */
function validateOptions (options) {
  if (!options.static) throw new Error('Missing --static.')
  if (!options.intake) throw new Error('Missing --intake.')
  if (!options.testCommand && !options.testCommandFile) {
    throw new Error('Missing --test-command or --test-command-file.')
  }
  if (!options.testExitCode && !options.testExitCodeFile) {
    throw new Error('Missing --test-exit-code or --test-exit-code-file.')
  }
}

/**
 * Reads a JSON file.
 *
 * @param {string} file file path
 * @returns {object} parsed JSON
 */
function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * Reads a required text value from an inline option or file option.
 *
 * @param {string|undefined} value inline value
 * @param {string|undefined} file text file path
 * @param {string} name value name
 * @returns {string} text value
 */
function readTextValue (value, file, name) {
  const text = readOptionalTextValue(value, file)
  if (!text) throw new Error(`Missing ${name}.`)
  return text
}

/**
 * Reads an optional text value from an inline option or file option.
 *
 * @param {string|undefined} value inline value
 * @param {string|undefined} file text file path
 * @returns {string|undefined} text value
 */
function readOptionalTextValue (value, file) {
  if (value !== undefined) return String(value).trim()
  if (!file) return

  return fs.readFileSync(path.resolve(file), 'utf8').trim()
}

/**
 * Gets env vars to render.
 *
 * @param {object} options report options
 * @param {object} analysis intake analysis
 * @returns {Array<Array<string>>} env entries
 */
function getEnvList (options, analysis) {
  const env = new Map(getDefaultEnv(analysis))

  for (const entry of readEnvFile(options.envFile)) {
    addEnvEntry(env, entry)
  }

  for (const entry of options.env || []) {
    addEnvEntry(env, entry)
  }

  return [
    ...DEFAULT_ENV_KEYS
      .filter(key => env.has(key))
      .map(key => [key, env.get(key)]),
    ...[...env.entries()].filter(([key]) => !DEFAULT_ENV_KEYS.includes(key)),
  ]
}

/**
 * Gets default env vars for the debug run.
 *
 * @param {object} analysis intake analysis
 * @returns {Array<Array<string>>} default env entries
 */
function getDefaultEnv (analysis) {
  return [
    ['DD_API_KEY', 'debug'],
    ['DD_SERVICE', 'dd-test-optimization-debug'],
    ['DD_CIVISIBILITY_AGENTLESS_ENABLED', '1'],
    ['DD_CIVISIBILITY_AGENTLESS_URL', analysis.summary.artifacts.intakeUrl || 'not available'],
    ['DD_INSTRUMENTATION_TELEMETRY_ENABLED', 'false'],
    ['NODE_OPTIONS', '-r dd-trace/ci/init'],
  ]
}

/**
 * Reads env entries from a file.
 *
 * @param {string|undefined} file env file path
 * @returns {string[]} env entries
 */
function readEnvFile (file) {
  if (!file) return []

  return fs.readFileSync(path.resolve(file), 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
}

/**
 * Adds a KEY=value entry to the env map.
 *
 * @param {Map<string, string>} env env map
 * @param {string} entry KEY=value entry
 */
function addEnvEntry (env, entry) {
  const index = entry.indexOf('=')
  if (index <= 0) return

  env.set(entry.slice(0, index), entry.slice(index + 1))
}

/**
 * Gets the HTML report path.
 *
 * @param {object} options report options
 * @param {object} analysis intake analysis
 * @returns {string} absolute HTML path
 */
function getHtmlPath (options, analysis) {
  return path.resolve(options.html || analysis.summary.artifacts.htmlPath || 'dd-test-optimization-report.html')
}

/**
 * Gets paths to report artifacts.
 *
 * @param {object} options report options
 * @param {string} staticPath static diagnosis path
 * @param {string} intakePath intake artifact path
 * @param {string} htmlPath HTML report path
 * @returns {object} artifact paths
 */
function getArtifactPaths (options, staticPath, intakePath, htmlPath) {
  return {
    agentJsonReportPath: path.resolve(options.agentJsonReport || 'dd-test-optimization-agent-report.json'),
    agentReportPath: path.resolve(options.agentReport || 'dd-test-optimization-agent-report.txt'),
    finalReportPath: path.resolve(options.out || 'dd-test-optimization-final-report.txt'),
    htmlPath,
    intakePath,
    staticPath,
  }
}

/**
 * Gets actionable static diagnosis findings.
 *
 * @param {object} staticReport static diagnosis report
 * @returns {Array<object>} actionable findings
 */
function getStaticHighlights (staticReport) {
  const results = Array.isArray(staticReport.results) ? staticReport.results : []
  const highlights = []
  const seen = new Set()

  for (const result of results) {
    if (result.status !== 'error' && result.status !== 'warning') continue

    const key = [result.status, result.title, result.message, result.recommendation].join('\0')
    if (seen.has(key)) continue

    seen.add(key)
    highlights.push(result)
  }

  return highlights
}

/**
 * Formats a static diagnosis finding.
 *
 * @param {object} finding static finding
 * @returns {string} formatted finding
 */
function formatStaticFinding (finding) {
  const parts = [
    `${finding.status}: ${finding.title}`,
    finding.message,
  ]

  if (finding.title === 'Missing Test Optimization initialization') {
    parts.push('Expected for this live run; Step 4 injected NODE_OPTIONS="-r dd-trace/ci/init".')
  } else if (finding.recommendation) {
    parts.push(finding.recommendation)
  }

  return parts.filter(Boolean).join(' - ')
}

/**
 * Gets "what this proves" text.
 *
 * @param {object} analysis intake analysis
 * @param {string} testCommand selected test command
 * @returns {string} proof statement
 */
function getProvesText (analysis, testCommand) {
  if (analysis.primaryStage === 'Reporting complete') {
    return `dd-trace/ci/init can report session, module, suite, and test events for: ${testCommand}`
  }

  if (analysis.primaryStage === 'EFD retried new test') {
    return `Early Flake Detection retried a new test for: ${testCommand}`
  }

  if (analysis.primaryStage === 'Auto test retry reported flaky test') {
    return `Auto Test Retries retried a known flaky test for: ${testCommand}`
  }

  if (analysis.primaryStage.startsWith('Test Management ') && analysis.primaryStage.endsWith(' reported')) {
    return `Test Management applied the expected managed-test behavior for: ${testCommand}`
  }

  return `The selected command reached stage "${analysis.primaryStage}" in the basic reporting funnel.`
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2))

  if (options.help) {
    console.log(getHelpText())
  } else if (options.unknown) {
    console.error(`Unknown argument: ${options.unknown}`)
    console.error(getHelpText())
    process.exitCode = 1
  } else {
    try {
      if (options.feedbackSummaryOut) {
        const feedbackSummary = renderFeedbackSummary(options)

        fs.writeFileSync(path.resolve(options.feedbackSummaryOut), `${feedbackSummary}\n`)
        console.log(feedbackSummary)
      } else {
        const report = renderFinalReport(options)

        if (options.out) {
          fs.writeFileSync(path.resolve(options.out), `${report}\n`)
        }

        if (options.summaryOut) {
          fs.writeFileSync(path.resolve(options.summaryOut), `${renderSummaryReport(options)}\n`)
        }

        console.log(report)
      }
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  }
}

module.exports = {
  getEfdExecutionDiagnostics,
  parseArgs,
  renderFeedbackSummary,
  renderFinalReport,
  renderSummaryReport,
}
