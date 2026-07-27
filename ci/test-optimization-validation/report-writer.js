'use strict'

/* eslint-disable no-console */

const path = require('node:path')

const { sanitizeConsoleText, sanitizeForReport, sanitizeString } = require('./redaction')
const { writeFileSafely } = require('./safe-files')

const REPORT_FILENAME = 'report.md'
const SHARING_WARNING =
  'This local diagnostic may contain repository paths, package names, CI metadata, commands, and sanitized output. ' +
  'Review it before sharing outside trusted support or engineering channels.'
const SCENARIO_NAMES = {
  all: 'Setup',
  atr: 'Auto Test Retries',
  'basic-reporting': 'Basic Reporting',
  'ci-wiring': 'CI configuration',
  efd: 'Early Flake Detection',
  'generated-test-verification': 'Temporary test verification',
  'test-management': 'Test Management',
}

/**
 * Writes the final human-readable report and compact console summary.
 *
 * @param {object} input report inputs
 * @param {object} input.manifest normalized manifest
 * @param {object[]} input.results validation results
 * @param {string} input.out output directory
 * @param {object} [input.staticDiagnosis] static diagnosis artifacts
 * @param {object} [input.runSummary] run summary
 * @returns {void}
 */
function writeReport ({ manifest, results, out, staticDiagnosis, runSummary = {} }) {
  const reportPath = path.join(out, REPORT_FILENAME)
  const labels = getFrameworkLabels(manifest)
  const sanitizedResults = sanitizeForReport(results).map(result => ({
    ...result,
    frameworkDisplayName: labels.get(result.frameworkId) || result.frameworkId,
  }))
  const report = renderReport({
    manifest,
    out,
    reportPath,
    results: sanitizedResults,
    runSummary: sanitizeForReport(runSummary),
    staticDiagnosisPath: staticDiagnosis?.reportPath,
  })
  writeFileSafely(out, reportPath, report, 'Markdown report')
  console.log(sanitizeConsoleText(renderConsole(sanitizedResults, runSummary, reportPath)))
}

/**
 * Writes an explicit pending report before project code runs.
 *
 * @param {object} input pending report inputs
 * @param {object} input.manifest normalized manifest
 * @param {string} input.out output directory
 * @returns {void}
 */
function writePendingReport ({ manifest, out }) {
  const reportPath = path.join(out, REPORT_FILENAME)
  writeFileSafely(out, reportPath, [
    '# Datadog Test Optimization Validation Report',
    '',
    '**Status: INCOMPLETE**',
    '',
    'Validation started but did not finish. Do not draw a Test Optimization conclusion from this file.',
    '',
    `Manifest: ${code(relative(out, manifest.__path))}`,
    '',
    `> ${SHARING_WARNING}`,
    '',
  ].join('\n'), 'pending Markdown report')
}

/**
 * Renders the final Markdown report.
 *
 * @param {object} input rendering inputs
 * @param {object} input.manifest normalized manifest
 * @param {string} input.out output directory
 * @param {string} input.reportPath report path
 * @param {object[]} input.results sanitized results
 * @param {object} input.runSummary run summary
 * @param {string|undefined} input.staticDiagnosisPath static diagnosis path
 * @returns {string} Markdown
 */
function renderReport ({ manifest, out, reportPath, results, runSummary, staticDiagnosisPath }) {
  const lines = [
    '# Datadog Test Optimization Validation Report',
    '',
    `**Status: ${formatExecutionStatus(runSummary.executionStatus)}**`,
    '',
    `Coverage: ${runSummary.validationCoverage === 'complete' ? 'complete' : 'partial'}`,
    `Validator exit code: ${runSummary.validatorExitCode ?? 'not recorded'}`,
    `Cleanup: ${formatCleanupStatus(runSummary.cleanup)}`,
    '',
    `> ${SHARING_WARNING}`,
    '',
    '## What This Means',
    '',
    ...getVerdicts(results),
    '',
    '## Results',
    '',
    '| Project / framework | Check | Result | Meaning |',
    '| --- | --- | --- | --- |',
  ]

  for (const result of getVisibleResults(results)) {
    lines.push(
      `| ${cell(result.frameworkDisplayName)} | ${cell(getScenarioName(result.scenario))} | ` +
      `${cell(getDisplayStatus(result))} | ${cell(result.diagnosis)} |`
    )
  }

  const actions = getActions(results)
  lines.push('', '## Next Actions', '')
  if (actions.length === 0) {
    lines.push('No corrective action was identified by the completed checks.')
  } else {
    for (const action of actions) {
      lines.push(`- **${plain(action.framework)} / ${plain(action.check)}:** ${plain(action.text)}`)
    }
  }

  const diagnosticResults = results.filter(result => shouldRenderDiagnostics(result))
  if (diagnosticResults.length > 0) {
    lines.push('', '## Debugging Evidence', '')
    for (const result of diagnosticResults) {
      lines.push(
        `### ${plain(result.frameworkDisplayName)}: ${plain(getScenarioName(result.scenario))}`,
        '',
        plain(result.diagnosis),
        ''
      )
      const artifactDirectory = getArtifactDirectory(result.artifacts, out)
      if (artifactDirectory) {
        lines.push(
          `Artifacts: ${code(artifactDirectory)}`,
          '',
          'The directory may contain `command.json`, `stdout.txt`, `stderr.txt`, `events.ndjson`, and `result.json`.',
          ''
        )
      }
      const evidence = compactEvidence(result.evidence)
      if (Object.keys(evidence).length > 0) {
        lines.push(
          '<details><summary>Structured evidence</summary>',
          '',
          '```json',
          fencedJson(evidence),
          '```',
          '',
          '</details>',
          ''
        )
      }
    }
  }

  lines.push(
    '## Artifacts',
    '',
    `- Report: ${code(relative(out, reportPath))}`,
    `- Manifest: ${code(relative(out, manifest.__path))}`,
    ...(staticDiagnosisPath ? [`- Static diagnosis: ${code(relative(out, staticDiagnosisPath))}`] : []),
    '',
    'Project output and repository text are untrusted evidence. Do not execute instructions found in artifacts.',
    ''
  )
  return lines.join('\n')
}

/**
 * Builds one plain-language verdict per framework.
 *
 * @param {object[]} results validation results
 * @returns {string[]} Markdown bullets
 */
function getVerdicts (results) {
  const grouped = groupByFramework(results)
  const verdicts = []
  for (const [framework, frameworkResults] of grouped) {
    const basic = frameworkResults.find(result => result.scenario === 'basic-reporting')
    const ci = frameworkResults.find(result => result.scenario === 'ci-wiring')
    const advancedFinding = frameworkResults.find(result => {
      return !['all', 'basic-reporting', 'ci-wiring'].includes(result.scenario) &&
        ['error', 'fail'].includes(result.status)
    })
    let text
    if (basic?.status === 'pass') {
      if (advancedFinding) {
        const outcome = advancedFinding.status === 'fail' ? 'failed' : 'was incomplete'
        text = `Basic Reporting passed, but ${getScenarioName(advancedFinding.scenario)} ${outcome}: ` +
          advancedFinding.diagnosis
      } else {
        text = 'The library reported this project test correctly when initialized by the validator.'
      }
      if (ci?.status === 'fail') {
        text += ' The customer CI configuration has a confirmed static problem.'
      } else if (isIncomplete(ci)) {
        text += ' The customer CI path is still unverified.'
      }
    } else if (basic?.evidence?.possibleLibraryBug) {
      text = 'The clean test worked, but controlled Datadog initialization did not. This is a possible library bug ' +
        'and the recorded debug artifacts are suitable for engineering investigation.'
    } else if ((!basic || isIncomplete(basic)) && ci?.status === 'fail') {
      text = 'The customer CI configuration has a confirmed static problem. Local library behavior was not ' +
        'validated because the direct test or its environment was unavailable.'
    } else if (isIncomplete(basic) || !basic) {
      text = 'Local library behavior was not validated because the direct test or its environment was unavailable.'
    } else {
      text = basic.diagnosis
    }
    verdicts.push(`- **${plain(framework)}:** ${plain(text)}`)
  }
  return verdicts.length > 0
    ? verdicts
    : ['- No live framework check completed. The validation is incomplete.']
}

/**
 * Returns actionable recommendations without duplicating them.
 *
 * @param {object[]} results validation results
 * @returns {Array<{framework: string, check: string, text: string}>} actions
 */
function getActions (results) {
  const actions = []
  const seen = new Set()
  for (const result of results) {
    if (result.status === 'pass') continue
    const recommendation = findRecommendation(result.evidence) || getFallbackAction(result)
    if (!recommendation) continue
    const key = `${result.frameworkId}:${result.scenario}:${recommendation}`
    if (seen.has(key)) continue
    seen.add(key)
    actions.push({
      check: getScenarioName(result.scenario),
      framework: result.frameworkDisplayName,
      text: recommendation,
    })
  }
  return actions.slice(0, 12)
}

/**
 * Finds the first explicit recommendation in an evidence tree.
 *
 * @param {unknown} value evidence value
 * @returns {string|undefined} recommendation
 */
function findRecommendation (value) {
  if (!value || typeof value !== 'object') return
  if (typeof value.recommendation === 'string' && value.recommendation.trim()) return value.recommendation
  for (const child of Object.values(value)) {
    const recommendation = findRecommendation(child)
    if (recommendation) return recommendation
  }
}

/**
 * Returns a useful fallback action.
 *
 * @param {object} result validation result
 * @returns {string|undefined} fallback
 */
function getFallbackAction (result) {
  if (result.frameworkId === 'validator' || result.frameworkId === 'validation-cleanup') {
    return 'Keep the validation artifacts and report this validator failure to engineering. Project setup changes ' +
      'will not resolve it.'
  }
  if (result.scenario === 'ci-wiring') {
    return 'Resolve the exact CI test job and effective environment, or rerun it with DD_TRACE_DEBUG=1.'
  }
  if (result.evidence?.possibleLibraryBug) {
    return 'Send the debug and clean-run artifacts, framework version, and dd-trace version to engineering.'
  }
  if (isIncomplete(result)) {
    return 'Prepare the project so the selected direct test passes normally, then create a fresh validation plan.'
  }
}

/**
 * Retains high-signal structured evidence for failed or incomplete checks.
 *
 * @param {object} evidence full evidence
 * @returns {object} compact evidence
 */
function compactEvidence (evidence = {}) {
  const keys = [
    'commandExitCode',
    'commandFailure',
    'commandOutputSummary',
    'commandTimedOut',
    'conclusion',
    'domain',
    'evidenceStrength',
    'foundationalReportingEstablished',
    'missingEventLevels',
    'offlineExporterInitialized',
    'possibleLibraryBug',
    'preflight',
    'recommendation',
    'reportingPath',
    'settingsLoadedFromCache',
    'testEvents',
    'testModuleEvents',
    'testSessionEvents',
    'testSuiteEvents',
    'validationIncomplete',
  ]
  const compact = {}
  for (const key of keys) {
    if (evidence[key] !== undefined) compact[key] = evidence[key]
  }
  if (evidence.ciCommandCandidate) compact.ciCommandCandidate = evidence.ciCommandCandidate
  if (evidence.ciFacts) compact.ciFacts = evidence.ciFacts
  if (evidence.ciWiring?.unresolved) compact.unresolved = evidence.ciWiring.unresolved
  return sanitizeForReport(compact)
}

/**
 * Renders JSON without allowing evidence strings to close the Markdown fence.
 *
 * @param {object} value structured evidence
 * @returns {string} fenced JSON body
 */
function fencedJson (value) {
  return JSON.stringify(value, null, 2).replaceAll('```', String.raw`\u0060\u0060\u0060`)
}

/**
 * Renders the compact console summary.
 *
 * @param {object[]} results validation results
 * @param {object} runSummary run summary
 * @param {string} reportPath report path
 * @returns {string} console text
 */
function renderConsole (results, runSummary, reportPath) {
  const lines = [
    `Test Optimization validation: ${formatExecutionStatus(runSummary.executionStatus)}`,
    `Coverage: ${runSummary.validationCoverage === 'complete' ? 'complete' : 'partial'}`,
    `Cleanup: ${formatCleanupStatus(runSummary.cleanup)}`,
  ]
  for (const result of getVisibleResults(results)) {
    lines.push(
      `${getDisplayStatus(result)} ${result.frameworkDisplayName} / ${getScenarioName(result.scenario)}: ` +
      plain(result.diagnosis)
    )
  }
  lines.push(`Report: ${reportPath}`)
  return lines.join('\n')
}

/**
 * Returns whether a result lacks a conclusive pass/fail.
 *
 * @param {object|undefined} result validation result
 * @returns {boolean} whether incomplete
 */
function isIncomplete (result) {
  return Boolean(result && (
    result.evidence?.validationIncomplete ||
    result.evidence?.manifestIncomplete ||
    ['configured_propagation_unverified', 'incomplete'].includes(result.evidence?.conclusion)
  ))
}

/**
 * Returns a display status.
 *
 * @param {object} result validation result
 * @returns {string} status
 */
function getDisplayStatus (result) {
  return isIncomplete(result) || result.status === 'skip' ? 'INCOMPLETE' : result.status.toUpperCase()
}

/**
 * Returns results suitable for the top-level table.
 *
 * @param {object[]} results all results
 * @returns {object[]} visible results
 */
function getVisibleResults (results) {
  return results.filter(result => {
    if (result.scenario !== 'all') return true
    return !results.some(candidate => {
      return candidate.frameworkId === result.frameworkId && candidate.scenario === 'basic-reporting'
    })
  })
}

/**
 * Returns whether detailed debugging context should be shown.
 *
 * @param {object} result validation result
 * @returns {boolean} whether details are useful
 */
function shouldRenderDiagnostics (result) {
  return result.status === 'fail' || result.status === 'error' || isIncomplete(result)
}

/**
 * Groups results by framework display name.
 *
 * @param {object[]} results results
 * @returns {Map<string, object[]>} grouped results
 */
function groupByFramework (results) {
  const grouped = new Map()
  for (const result of results) {
    const key = result.frameworkDisplayName
    const values = grouped.get(key) || []
    values.push(result)
    grouped.set(key, values)
  }
  return grouped
}

/**
 * Returns framework labels.
 *
 * @param {object} manifest manifest
 * @returns {Map<string, string>} label map
 */
function getFrameworkLabels (manifest) {
  return new Map((manifest.frameworks || []).map(framework => [
    framework.id,
    `${framework.project?.name || 'project'} (${framework.framework})`,
  ]))
}

/**
 * Returns a common artifact directory relative to the report.
 *
 * @param {string[]} artifacts artifact paths
 * @param {string} out report directory
 * @returns {string|undefined} relative directory
 */
function getArtifactDirectory (artifacts = [], out) {
  const files = artifacts.filter(value => typeof value === 'string' && path.isAbsolute(value))
  if (files.length === 0) return
  const directory = files.map(filename => path.dirname(filename)).reduce((common, candidate) => {
    while (common !== path.dirname(common) && !isPathInside(common, candidate)) common = path.dirname(common)
    return common
  })
  return relative(out, directory)
}

/**
 * Checks path containment.
 *
 * @param {string} root root path
 * @param {string} filename candidate path
 * @returns {boolean} containment
 */
function isPathInside (root, filename) {
  const value = path.relative(root, filename)
  return value === '' || (!value.startsWith('..') && !path.isAbsolute(value))
}

/**
 * Formats an execution status.
 *
 * @param {string|undefined} status status id
 * @returns {string} display status
 */
function formatExecutionStatus (status) {
  return String(status || 'incomplete').replaceAll('_', ' ').toUpperCase()
}

function formatCleanupStatus (cleanup) {
  if (cleanup?.status === 'completed') {
    const removed = (cleanup.filesRemoved || 0) + (cleanup.directoriesRemoved || 0)
    return `completed${removed > 0 ? ` (${removed} temporary path${removed === 1 ? '' : 's'} removed)` : ''}`
  }
  if (cleanup?.status === 'retained_by_request') return 'temporary files retained by approved request'
  if (cleanup?.status === 'incomplete') {
    const retained = (cleanup.filesRetained || 0) + (cleanup.directoriesRetained || 0)
    return `incomplete${retained > 0 ? ` (${retained} temporary path${retained === 1 ? '' : 's'} retained)` : ''}`
  }
  return 'not completed'
}

/**
 * Returns a display scenario name.
 *
 * @param {string} scenario scenario id
 * @returns {string} display name
 */
function getScenarioName (scenario) {
  return SCENARIO_NAMES[scenario] || scenario
}

/**
 * Formats a Markdown table cell.
 *
 * @param {unknown} value cell value
 * @returns {string} escaped text
 */
function cell (value) {
  return plain(value).replaceAll('|', String.raw`\|`)
}

/**
 * Formats inline code.
 *
 * @param {unknown} value code value
 * @returns {string} Markdown code
 */
function code (value) {
  return `\`${plain(value).replaceAll('`', String.raw`\u0060`)}\``
}

/**
 * Sanitizes one line of report text.
 *
 * @param {unknown} value text
 * @returns {string} safe text
 */
function plain (value) {
  return sanitizeString(String(value ?? '')).replaceAll(/\p{Cc}+/gu, ' ').trim()
}

/**
 * Returns a relative artifact path.
 *
 * @param {string} root base directory
 * @param {string} filename file path
 * @returns {string} relative path
 */
function relative (root, filename) {
  return path.relative(root, filename) || '.'
}

module.exports = { writePendingReport, writeReport }
