#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const {
  analyzeIntakeArtifact,
} = require('./test-optimization-intake-analysis')
const {
  buildValidationPayload,
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

const SECRET_KEY_RE = /(?:API_?KEY|TOKEN|SECRET|PASSWORD)/i

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
    } else if (arg === '--new-test-snippet') {
      options.newTestSnippet = args[++i]
    } else if (arg.startsWith('--new-test-snippet=')) {
      options.newTestSnippet = arg.slice('--new-test-snippet='.length)
    } else if (arg === '--new-test-snippet-file') {
      options.newTestSnippetFile = args[++i]
    } else if (arg.startsWith('--new-test-snippet-file=')) {
      options.newTestSnippetFile = arg.slice('--new-test-snippet-file='.length)
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
    '  --new-test-snippet <text>       Include the temporary test snippet used for EFD.',
    '  --new-test-snippet-file <file>  Read the temporary test snippet used for EFD.',
    '  --env KEY=value                Include an environment variable used for the live run.',
    '  --env-file <file>              Read environment variables, one KEY=value per line.',
    '  --agent-report <file>          Path to the plain text analyzer artifact.',
    '  --agent-json-report <file>     Path to the JSON analyzer artifact.',
    '  --html <file>                  Override the HTML report path.',
    '  --out <file>                   Write the final report to a file.',
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
  const newTestSnippet = readOptionalTextValue(options.newTestSnippet, options.newTestSnippetFile)
  const env = getEnvList(options, analysis)
  const htmlPath = getHtmlPath(options, analysis)
  const htmlFileUrl = analysis.summary.artifacts.htmlFileUrl || pathToFileURL(htmlPath).href
  const frameworkSummary = getFrameworkSummary(staticReport)
  const staticHighlights = getStaticHighlights(staticReport)
  const artifactPaths = getArtifactPaths(options, staticPath, intakePath, htmlPath)
  const validationAppUrl = getValidationAppUrl(buildValidationPayload({
    analysis,
    artifacts: {
      ...artifactPaths,
      htmlFileUrl,
    },
    env,
    newTestSnippet,
    staticReport,
    testCommand,
    testExitCode,
    testResult,
  }))

  const lines = [
    `HTML report: ${htmlFileUrl}`,
    `HTML report path: ${htmlPath}`,
    `Datadog validation: ${validationAppUrl}`,
    '',
    `Primary funnel stage: ${analysis.primaryStage}`,
    '',
    'Scope:',
    ...getScopeLines(analysis),
    '',
    'Summary:',
    `- dd-trace: ${staticReport.ddTraceVersion || 'unknown'}`,
    `- Framework: ${frameworkSummary}`,
    `- Requests: ${analysis.summary.requestCount}`,
    `- citestcycle payloads: ${analysis.summary.citestcycle.payloadCount}`,
    '- Event levels: ' +
      `sessions=${analysis.summary.events.counts.test_session_end}, ` +
      `modules=${analysis.summary.events.counts.test_module_end}, ` +
      `suites=${analysis.summary.events.counts.test_suite_end}, ` +
      `tests=${analysis.summary.events.counts.test}`,
    `- Decode errors: ${analysis.summary.decodeErrors.length}`,
    `- Test exit code: ${testExitCode}`,
    `- Test result: ${testResult || 'not recorded'}`,
    `- Intake shutdown: ${intakeArtifact.intake?.stoppedAt ? 'successful' : 'not confirmed'}`,
    `- Final artifact flushed: ${intakeArtifact.intake?.stoppedAt ? 'yes' : 'partial artifact possible'}`,
    ...getEfdSummaryLines(analysis),
    '',
    'Consistency checks:',
    ...getConsistencyChecks(env, intakeArtifact, analysis),
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

  lines.push('', 'Static diagnosis highlights:')
  if (staticHighlights.length === 0) {
    lines.push('- none')
  } else {
    for (const finding of staticHighlights) {
      lines.push(`- ${formatStaticFinding(finding)}`)
    }
  }

  lines.push(
    '',
    'Test command used:',
    testCommand,
    '',
    'Env vars used, without real secrets:'
  )

  for (const [key, value] of env) {
    lines.push(`- ${key}=${maskEnvValue(key, value)}`)
  }

  lines.push(
    '',
    'What this proves:',
    `- ${getProvesText(analysis, testCommand)}`,
    '',
    'What this does not prove:',
    '- The full test suite reports correctly.',
    '- The CI workflow is configured correctly.',
    ...getNotProvenLines(analysis),
    '',
    'Recommended next actions:'
  )

  for (const recommendation of getRecommendations(staticHighlights)) {
    lines.push(`- ${recommendation}`)
  }

  lines.push(
    '',
    'Diagnostic answers:',
    '- Is dd-trace installed and statically configured in a supported way? ' +
      getStaticSetupAnswer(staticReport, staticHighlights),
    '- Does dd-trace/ci/init reach the test process through NODE_OPTIONS? ' +
      getInitializationAnswer(analysis),
    '- Does the selected test subset send Test Optimization requests to the local fake intake? ' +
      getIntakeAnswer(analysis),
    '- If data is reported, does it include session, module, suite, and test events? ' +
      getEventLevelsAnswer(analysis),
    '',
    'Artifacts:',
    `- Final report: ${artifactPaths.finalReportPath}`,
    `- Static diagnosis: ${artifactPaths.staticPath}`,
    `- Agent report: ${artifactPaths.agentReportPath}`,
    `- Agent JSON report: ${artifactPaths.agentJsonReportPath}`,
    `- Intake artifact: ${artifactPaths.intakePath}`,
    `- HTML report path: ${artifactPaths.htmlPath}`,
    `- HTML report file URL: ${htmlFileUrl}`
  )

  return lines.join('\n')
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

  if (analysis.summary.efd.settingsEnabled) {
    lines.push(
      '- EFD check: known tests endpoint, new-test detection, and retry evidence for the selected subset.',
      '- Does not validate ITR, test skipping, test management, coverage, or the full CI workflow.'
    )
  } else {
    lines.push('- Does not validate EFD, ITR, test skipping, test management, coverage, or the full CI workflow.')
  }

  return lines
}

/**
 * Gets optional EFD summary lines.
 *
 * @param {object} analysis intake analysis
 * @returns {string[]} EFD summary lines
 */
function getEfdSummaryLines (analysis) {
  if (!analysis.summary.efd.settingsEnabled && !analysis.summary.efd.requested) return []

  return [
    `- EFD settings enabled: ${analysis.summary.efd.settingsEnabled ? 'yes' : 'no'}`,
    `- Known tests requested: ${analysis.summary.efd.requested ? 'yes' : 'no'}`,
    `- Known tests received: ${analysis.summary.efd.knownTestsReceived}`,
    `- New tests observed: ${analysis.summary.efd.newTests.length}`,
    `- Retried new tests: ${analysis.summary.efd.retriedNewTests}`,
  ]
}

/**
 * Gets limitations that remain unproven.
 *
 * @param {object} analysis intake analysis
 * @returns {string[]} limitation lines
 */
function getNotProvenLines (analysis) {
  if (analysis.summary.efd.settingsEnabled) {
    return ['- ITR, test skipping, test management, or coverage are working.']
  }

  return ['- EFD, ITR, test skipping, test management, or coverage are working.']
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
 * Gets consistency checks between the env file, raw intake artifact, and analyzer summary.
 *
 * @param {Array<Array<string>>} env rendered env entries
 * @param {object} intakeArtifact raw intake artifact
 * @param {object} analysis analyzer output
 * @returns {string[]} rendered consistency checks
 */
function getConsistencyChecks (env, intakeArtifact, analysis) {
  const envIntakeUrl = getEnvValue(env, 'DD_CIVISIBILITY_AGENTLESS_URL')
  const artifactIntakeUrl = analysis.summary.artifacts.intakeUrl || intakeArtifact.intake?.url
  const rawRequestCount = Array.isArray(intakeArtifact.requests) ? intakeArtifact.requests.length : 0
  const analyzedRequestCount = analysis.summary.requestCount

  return [
    '- Intake URL: ' + formatConsistencyResult(envIntakeUrl === artifactIntakeUrl, [
      `env=${envIntakeUrl || 'missing'}`,
      `artifact=${artifactIntakeUrl || 'missing'}`,
    ]),
    '- Request count: ' + formatConsistencyResult(rawRequestCount === analyzedRequestCount, [
      `artifact=${rawRequestCount}`,
      `analyzer=${analyzedRequestCount}`,
    ]),
  ]
}

/**
 * Gets a value from rendered env entries.
 *
 * @param {Array<Array<string>>} env rendered env entries
 * @param {string} key env key
 * @returns {string|undefined} env value
 */
function getEnvValue (env, key) {
  const entry = env.find(([entryKey]) => entryKey === key)
  return entry && entry[1]
}

/**
 * Formats a consistency check.
 *
 * @param {boolean} matches whether the check passed
 * @param {string[]} details rendered details
 * @returns {string} rendered check
 */
function formatConsistencyResult (matches, details) {
  return `${matches ? 'ok' : 'mismatch'} (${details.join(', ')})`
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
 * Masks secret-looking env values.
 *
 * @param {string} key env key
 * @param {string} value env value
 * @returns {string} rendered value
 */
function maskEnvValue (key, value) {
  if (value === 'debug') return value
  if (SECRET_KEY_RE.test(key)) return '<redacted>'

  return value
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
 * Gets supported framework summary text.
 *
 * @param {object} staticReport static diagnosis report
 * @returns {string} framework summary
 */
function getFrameworkSummary (staticReport) {
  const frameworks = Array.isArray(staticReport.supportedFrameworks) ? staticReport.supportedFrameworks : []
  if (frameworks.length === 0) return 'none detected'

  return frameworks.map(framework => {
    const version = getFrameworkVersion(framework)
    return version ? `${framework.name} ${version}` : framework.name
  }).join(', ')
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
 * Gets actionable static diagnosis findings.
 *
 * @param {object} staticReport static diagnosis report
 * @returns {Array<object>} actionable findings
 */
function getStaticHighlights (staticReport) {
  const results = Array.isArray(staticReport.results) ? staticReport.results : []
  return results.filter(result => result.status === 'error' || result.status === 'warning')
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
 * Gets recommendations from static findings.
 *
 * @param {Array<object>} staticHighlights actionable static findings
 * @returns {string[]} recommendations
 */
function getRecommendations (staticHighlights) {
  const recommendations = []

  if (hasStaticFinding(staticHighlights, 'Missing Test Optimization initialization')) {
    recommendations.push(
      'Add NODE_OPTIONS="-r dd-trace/ci/init" to the CI job that runs the selected test command.'
    )
  }

  if (hasStaticFinding(staticHighlights, 'DD_SERVICE was not found')) {
    recommendations.push('Set DD_SERVICE to the service name used for Test Optimization grouping.')
  }

  for (const finding of staticHighlights) {
    if (!finding.recommendation) continue
    if (finding.title === 'Missing Test Optimization initialization') continue
    if (finding.title === 'DD_SERVICE was not found') continue

    recommendations.push(finding.recommendation)
  }

  if (recommendations.length === 0) {
    recommendations.push('No basic reporting fix is needed for the selected test subset.')
  }

  return [...new Set(recommendations)]
}

/**
 * Checks whether a static finding title is present.
 *
 * @param {Array<object>} findings static findings
 * @param {string} title finding title
 * @returns {boolean} true when present
 */
function hasStaticFinding (findings, title) {
  return findings.some(finding => finding.title === title)
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

  return `The selected command reached stage "${analysis.primaryStage}" in the basic reporting funnel.`
}

/**
 * Gets static setup answer text.
 *
 * @param {object} staticReport static diagnosis report
 * @param {Array<object>} staticHighlights actionable static findings
 * @returns {string} answer text
 */
function getStaticSetupAnswer (staticReport, staticHighlights) {
  const errors = staticHighlights.filter(finding => finding.status === 'error')
  const warnings = staticHighlights.filter(finding => finding.status === 'warning')

  return `${staticReport.ddTraceVersion || 'unknown'} detected; ${errors.length} error(s), ` +
    `${warnings.length} warning(s) in static diagnosis.`
}

/**
 * Gets initialization answer text.
 *
 * @param {object} analysis intake analysis
 * @returns {string} answer text
 */
function getInitializationAnswer (analysis) {
  if (analysis.summary.citestcycle.payloadCount > 0) {
    return 'yes; inferred from citestcycle payloads reaching the fake intake.'
  }

  return 'not confirmed; no citestcycle payload reached the fake intake.'
}

/**
 * Gets intake answer text.
 *
 * @param {object} analysis intake analysis
 * @returns {string} answer text
 */
function getIntakeAnswer (analysis) {
  if (analysis.summary.anyRequestReceived) {
    return `yes; ${analysis.summary.requestCount} request(s) reached the fake intake.`
  }

  return 'no; zero requests reached the fake intake.'
}

/**
 * Gets event levels answer text.
 *
 * @param {object} analysis intake analysis
 * @returns {string} answer text
 */
function getEventLevelsAnswer (analysis) {
  if (analysis.summary.citestcycle.payloadCount > 0 && analysis.summary.events.missingLevels.length === 0) {
    return 'yes; session, module, suite, and test events are present.'
  }

  if (analysis.summary.events.missingLevels.length > 0) {
    return `no; missing ${analysis.summary.events.missingLevels.join(', ')}.`
  }

  return 'not confirmed; no citestcycle payload was captured.'
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
      const report = renderFinalReport(options)

      if (options.out) {
        fs.writeFileSync(path.resolve(options.out), `${report}\n`)
      }

      console.log(report)
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  }
}

module.exports = {
  parseArgs,
  renderFinalReport,
}
