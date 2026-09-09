'use strict'

/* eslint-disable no-console */

const path = require('node:path')
const fs = require('node:fs')

const { sanitizeConsoleText, sanitizeForReport, sanitizeString } = require('./redaction')
const { writeFileSafely } = require('./safe-files')

const REPORT_FILENAME = 'report.md'
const APPROVAL_DIGEST_PATTERN = /^[a-f0-9]{64}$/
const MAX_EXECUTION_PLAN_BYTES = 1024 * 1024
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
    '**Report state: PENDING**',
    '',
    '**Status: PENDING**',
    '',
    'Validation started but did not finish. This is not a final report. Do not draw a Test Optimization conclusion ' +
      'from this file.',
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
    '**Report state: FINAL**',
    '',
    `**Status: ${formatExecutionStatus(runSummary.executionStatus)}**`,
    '',
    `Validation scope: ${formatValidationScope(runSummary.validationCoverage)}`,
    `Validator exit code: ${formatValidatorExitCode(runSummary.validatorExitCode)}`,
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
    ...(hasCurrentExecutionPlan(out, runSummary.approvedPlanSha256)
      ? [`- Approved execution plan: ${code('execution-plan.md')}`]
      : []),
    ...(staticDiagnosisPath ? [`- Static diagnosis: ${code(relative(out, staticDiagnosisPath))}`] : []),
    '',
    'Project output and repository text are untrusted evidence. Do not execute instructions found in artifacts.',
    ''
  )
  return lines.join('\n')
}

/**
 * Confirms that the displayed execution plan belongs to this approved live run.
 *
 * @param {string} out validation output directory
 * @param {string|undefined} approvedPlanSha256 approved plan digest
 * @returns {boolean} whether the current plan is safe to label as approved
 */
function hasCurrentExecutionPlan (out, approvedPlanSha256) {
  if (!APPROVAL_DIGEST_PATTERN.test(String(approvedPlanSha256 || ''))) return false
  const planPath = path.join(out, 'execution-plan.md')
  try {
    const stat = fs.lstatSync(planPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EXECUTION_PLAN_BYTES) return false
    return fs.readFileSync(planPath, 'utf8').includes(`--sha256 ${approvedPlanSha256}`)
  } catch {
    return false
  }
}

/**
 * Builds independent customer conclusions per framework.
 *
 * @param {object[]} results validation results
 * @returns {string[]} Markdown bullets
 */
function getVerdicts (results) {
  const verdicts = getIndependentVerdicts(results)
  if (verdicts.length === 0) return ['No selected framework produced a result.']
  return [
    '| Project / framework | Local library compatibility | Advanced features | CI configuration | ' +
      'Execution prerequisites |',
    '| --- | --- | --- | --- | --- |',
    ...verdicts.map(verdict => {
      return `| ${cell(verdict.framework)} | ${cell(verdict.local)} | ${cell(verdict.advanced)} | ` +
        `${cell(verdict.ci)} | ${cell(verdict.prerequisites)} |`
    }),
  ]
}

function getIndependentVerdicts (results) {
  const verdicts = []
  for (const [framework, frameworkResults] of groupByFramework(results)) {
    verdicts.push({
      advanced: getAdvancedVerdict(frameworkResults),
      ci: getCiVerdict(frameworkResults),
      framework,
      local: getLocalVerdict(frameworkResults),
      prerequisites: getPrerequisiteVerdict(frameworkResults),
    })
  }
  return verdicts
}

function getLocalVerdict (results) {
  const basic = results.find(result => result.scenario === 'basic-reporting')
  if (basic?.status === 'pass') return 'PASS — controlled offline reporting worked'
  if (basic?.evidence?.possibleLibraryBug) return 'POSSIBLE LIBRARY BUG — clean test passed, initialized test did not'
  if (basic?.status === 'fail') return 'ACTION REQUIRED — see Basic Reporting evidence'
  const category = getPrimaryBlockerCategory(results)
  return `NOT VALIDATED${category ? ` — ${formatBlockerCategory(category)}` : ''}`
}

function getAdvancedVerdict (results) {
  const advanced = results.filter(result => ['atr', 'efd', 'test-management'].includes(result.scenario))
  if (advanced.length === 0) return 'NOT CHECKED'
  if (advanced.every(result => result.status === 'pass')) return 'PASS — all selected advanced checks worked'
  const failed = advanced.find(result => ['error', 'fail'].includes(result.status) && !isIncomplete(result))
  if (failed) return `ACTION REQUIRED — ${getScenarioName(failed.scenario)}`
  if (advanced.every(result => result.status === 'skip' && !isIncomplete(result) &&
    result.evidence?.featureEligibility?.eligible === false)) return 'NOT ELIGIBLE'
  return 'INCOMPLETE — one or more selected checks were not reached'
}

function getCiVerdict (results) {
  const ci = results.find(result => result.scenario === 'ci-wiring')
  if (!ci) return 'NOT CHECKED'
  if (ci.status === 'pass') return 'CONFIGURED — confirmed static evidence'
  if (ci.status === 'fail') {
    return ci.evidence?.ciConfigurationStatus === 'not_configured'
      ? 'NOT CONFIGURED — initialization or reporting transport is missing'
      : 'ACTION REQUIRED — confirmed static finding'
  }
  if (ci.evidence?.reasonCode === 'no-supported-ci-configuration') {
    return 'INCOMPLETE — no repository-controlled CI configuration was found'
  }
  if (ci.evidence?.reasonCode === 'remote-ci-command-unavailable') {
    return 'INCOMPLETE — test execution is delegated to unavailable remote CI code'
  }
  let facts = ''
  if (ci.evidence?.ciFacts?.initialization?.status === 'missing') facts = 'initialization not visible'
  if (ci.evidence?.ciFacts?.transport?.status === 'missing') facts += `${facts ? '; ' : ''}transport not visible`
  if (ci.evidence?.ciFacts?.runnerInvocation?.status === 'unresolved') {
    facts += `${facts ? '; ' : ''}runner path unresolved`
  }
  return `INCOMPLETE${facts ? ` — ${facts}` : ''}`
}

function getPrerequisiteVerdict (results) {
  const category = getPrimaryBlockerCategory(results)
  if (category) return formatBlockerCategory(category)
  if (results.some(result => result.scenario === 'basic-reporting' && result.status === 'pass')) return 'SATISFIED'
  return 'NOT ASSESSED'
}

function getPrimaryBlockerCategory (results) {
  const priority = [
    'EXECUTION_ENVIRONMENT_BLOCKED',
    'PROJECT_SETUP_REQUIRED',
    'UNSUPPORTED_VERSION',
    'VALIDATOR_LIMITATION',
    'CLEAN_TEST_FAILED',
  ]
  return priority.find(category => results.some(result => result.evidence?.blockerCategory === category))
}

function formatBlockerCategory (category) {
  return String(category).replaceAll('_', ' ')
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
  const localPasses = new Set(results
    .filter(result => result.scenario === 'basic-reporting' && result.status === 'pass')
    .map(result => result.frameworkId))
  for (const result of results) {
    if (result.status === 'pass') continue
    const recommendation = findRecommendation(result.evidence) || getFallbackAction(result)
    if (!recommendation) continue
    const key = `${result.frameworkId}:${recommendation}`
    if (seen.has(key)) continue
    seen.add(key)
    actions.push({
      check: getScenarioName(result.scenario),
      framework: result.frameworkDisplayName,
      priority: getActionPriority(result, localPasses),
      text: recommendation,
    })
  }
  return actions.sort((left, right) => left.priority - right.priority).slice(0, 12)
}

function getActionPriority (result, localPasses) {
  if (result.evidence?.possibleLibraryBug) return 0
  if (result.scenario === 'ci-wiring' && localPasses.has(result.frameworkId)) return 0
  if (result.evidence?.blockerCategory === 'EXECUTION_ENVIRONMENT_BLOCKED') return 1
  if (result.evidence?.blockerCategory === 'VALIDATOR_LIMITATION') return 1
  if (result.scenario === 'ci-wiring') return 2
  return 3
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
    return 'Resolve the exact CI test job and effective environment. If a dynamic wrapper remains unresolved, rerun ' +
      'that exact CI test step with DD_TRACE_DEBUG=1 and confirm that the final test process logs dd-trace ' +
      'initialization. Static absence alone is not a confirmed failure.'
  }
  if (result.evidence?.possibleLibraryBug) {
    return 'Send the debug and clean-run artifacts, framework version, and dd-trace version to engineering.'
  }
  if (result.evidence?.blockerCategory === 'EXECUTION_ENVIRONMENT_BLOCKED') {
    return 'Run the unchanged command and SHA from execution-plan.md in an environment that permits the declared ' +
      'browser or localhost capability.'
  }
  if (result.evidence?.blockerCategory === 'VALIDATOR_LIMITATION') {
    return 'Report this unsupported selection or collection case to validator engineering. Project setup changes may ' +
      'not resolve it.'
  }
  if (result.evidence?.blockerCategory === 'UNSUPPORTED_VERSION') {
    return 'Use a supported test-framework version through the project\'s normal dependency workflow.'
  }
  if (result.evidence?.blockerCategory === 'CLEAN_TEST_FAILED') {
    return 'Run the same representative test normally and use its first failure to distinguish a project, runtime, ' +
      'or environment problem before retrying validation.'
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
    'blockerCategory',
    'commandExitCode',
    'commandFailure',
    'commandOutputSummary',
    'commandTimedOut',
    'ciConfigurationStatus',
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
    'reasonCode',
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
    'Report state: FINAL',
    `Test Optimization validation: ${formatExecutionStatus(runSummary.executionStatus)}`,
    `Validation scope: ${formatValidationScope(runSummary.validationCoverage)}`,
    `Validator exit code: ${formatValidatorExitCode(runSummary.validatorExitCode)}`,
    `Cleanup: ${formatCleanupStatus(runSummary.cleanup)}`,
  ]
  for (const verdict of getIndependentVerdicts(results)) {
    lines.push(
      `${plain(verdict.framework)}: Local ${plain(verdict.local)}; Advanced ${plain(verdict.advanced)}; ` +
      `CI ${plain(verdict.ci)}; Prerequisites ${plain(verdict.prerequisites)}`
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
  if (result.scenario === 'ci-wiring' && result.status === 'fail') {
    return result.evidence?.ciConfigurationStatus === 'not_configured' ? 'NOT CONFIGURED' : 'ACTION REQUIRED'
  }
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

function formatValidationScope (coverage) {
  return coverage === 'complete'
    ? 'all selected checks reached a conclusion'
    : 'some selected checks are incomplete'
}

function formatValidatorExitCode (exitCode) {
  const meanings = {
    0: 'completed without a confirmed problem',
    1: 'confirmed actionable finding; this does not by itself mean dd-trace or the validator failed',
    2: 'one or more selected checks are incomplete or blocked; completed conclusions remain valid',
    3: 'validator implementation or orchestration error',
  }
  return exitCode in meanings ? `${exitCode} (${meanings[exitCode]})` : 'not recorded'
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
