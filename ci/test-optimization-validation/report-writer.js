'use strict'

/* eslint-disable no-console */

const fs = require('fs')
const path = require('path')

const { buildCiCommandCandidate } = require('./ci-command-candidate')
const { normalizeRequests } = require('./payload-normalizer')
const { sanitizeForReport, sanitizeString } = require('./redaction')
const { buildValidationPayloads } = require('./validation-payload')

const CI_WIRING_SCENARIO = 'ci-wiring'
const SHARING_WARNING =
  'The generated Markdown report and run artifacts are local/internal diagnostics and are not ' +
  'public-shareable as-is. They may include repository paths, package names, CI workflow/job/step names, ' +
  'commands, runner/tool chains, and sanitized environment variable structure. Secret-like values are redacted ' +
  'on a best-effort basis, but review and redact before sharing outside trusted channels.'

function writeReport ({ manifest, results, out, intake, staticDiagnosis }) {
  const intakeArtifacts = intake.writeArtifacts()
  const normalizedEvents = normalizeRequests(intake.requests)
  const normalizedPath = path.join(out, 'intake', 'payloads.normalized.ndjson')
  const sanitizedEvents = sanitizeForReport(normalizedEvents)
  fs.writeFileSync(
    normalizedPath,
    sanitizedEvents.map(event => JSON.stringify(event)).join('\n') + '\n'
  )

  const reportPath = path.join(out, 'report.md')
  const baseArtifacts = {
    manifest: manifest.__path,
    normalizedPayloads: normalizedPath,
    report: reportPath,
    reportPath,
    requests: intakeArtifacts.requestsPath,
    staticDiagnosis: staticDiagnosis && staticDiagnosis.reportPath,
  }
  const validationPayloads = buildValidationPayloads({
    manifest,
    results,
    artifacts: baseArtifacts,
  })

  const sanitizedManifest = sanitizeForReport(stripPrivateFields(manifest))
  const sanitizedResults = sanitizeForReport(results)
  const report = {
    generatedAt: new Date().toISOString(),
    sharingWarning: SHARING_WARNING,
    manifestPath: manifest.__path,
    ciDiscovery: sanitizeForReport(manifest.ciDiscovery),
    ciCommandCandidates: sanitizeForReport(getCiCommandCandidates(manifest)),
    omitted: sanitizeForReport(getStringArray(manifest.omitted)),
    omittedTestCommands: sanitizeForReport(
      Array.isArray(manifest.omittedTestCommands) ? manifest.omittedTestCommands : []
    ),
    results: sanitizedResults,
    staticDiagnosisNotes: getStaticDiagnosisNotes(staticDiagnosis?.report),
    staticDiagnosisReport: sanitizeForReport(staticDiagnosis?.report),
    manifest: sanitizedManifest,
    artifacts: {
      ...baseArtifacts,
    },
    validation: validationPayloads.map(payload => ({
      frameworkId: payload.frameworkId,
      framework: payload.payload.framework,
      payload: payload.payload,
    })),
  }

  fs.writeFileSync(reportPath, renderMarkdown(report))

  console.log(renderConsoleSummary(sanitizedResults, reportPath))
}

function renderMarkdown (report) {
  const lines = [
    '# Datadog Test Optimization Validation Report',
    '',
    `Generated at: ${report.generatedAt}`,
    '',
    `> ${report.sharingWarning}`,
    '',
    '## Summary',
    '',
  ]

  appendMarkdownResultSection(lines, 'Basic Reporting', getBasicReportingResults(report.results))
  appendMarkdownResultSection(lines, 'CI Wiring', getCiWiringResults(report.results))
  appendMarkdownResultSection(lines, 'Advanced Features', getAdvancedFeatureResults(report.results))
  appendMarkdownCiDiscovery(lines, report.ciDiscovery)
  appendMarkdownStaticDiagnosisNotes(lines, report.staticDiagnosisNotes)
  appendMarkdownCiCommandCandidates(lines, report.ciCommandCandidates)
  appendMarkdownOmittedCommands(lines, report)
  appendMarkdownResultDetails(lines, report.results)

  const diagnosticResults = getDiagnosticOnlyResults(report.results)
  if (diagnosticResults.length > 0) {
    lines.push('', '## Diagnostic-only and Blocked Frameworks', '')
    for (const result of diagnosticResults) {
      lines.push(`- ${result.status.toUpperCase()} ${result.frameworkId}: ${result.diagnosis}`)
    }
  }

  lines.push('', '## Framework Context', '')
  for (const validation of report.validation) {
    const context = formatFrameworkContext(validation.framework, { markdown: true })
    lines.push(`- ${validation.frameworkId}: ${context}`)
  }

  lines.push('', '## Key Artifacts', '')
  for (const [name, artifactPath] of getKeyArtifacts(report.artifacts)) {
    if (!artifactPath) continue
    lines.push(`- ${name}: \`${artifactPath}\``)
  }

  appendMarkdownJsonSection(lines, 'Validation Payloads JSON', report.validation.map(validation => ({
    frameworkId: validation.frameworkId,
    payload: validation.payload,
  })))
  appendMarkdownJsonSection(lines, 'Execution Results JSON', report.results)
  appendMarkdownJsonSection(lines, 'Normalized Manifest JSON', report.manifest)
  appendMarkdownJsonSection(lines, 'Static Diagnosis JSON', report.staticDiagnosisReport)

  return lines.join('\n')
}

function getCiCommandCandidates (manifest) {
  const candidates = []

  for (const framework of manifest.frameworks || []) {
    const candidate = buildCiCommandCandidate(framework)
    if (!candidate) continue
    candidates.push({
      frameworkId: framework.id,
      ...candidate,
    })
  }

  return candidates
}

function getStringArray (values) {
  if (!Array.isArray(values)) return []
  return values.filter(value => typeof value === 'string')
}

function getStaticDiagnosisNotes (diagnosis) {
  const results = Array.isArray(diagnosis?.results) ? diagnosis.results : []
  const notes = []

  if (results.some(isMissingStaticInitializationResult)) {
    notes.push(
      'Static diagnosis reported missing NODE_OPTIONS/dd-trace/ci/init. In this validation report, that is a ' +
      'CI wiring/static configuration finding, not a direct-initialization Basic Reporting blocker.'
    )
  }

  return notes
}

function isMissingStaticInitializationResult (result) {
  return result?.title === 'Missing Test Optimization initialization' ||
    result?.title === 'CI workflows do not show Test Optimization initialization'
}

function appendMarkdownCiDiscovery (lines, ciDiscovery) {
  if (!ciDiscovery) return

  lines.push(
    '## CI Discovery',
    '',
    `- Method: \`${ciDiscovery.method || 'unknown'}\``
  )
  appendMarkdownList(lines, 'Searched', ciDiscovery.searched)
  appendMarkdownList(lines, 'Found', ciDiscovery.found)
  appendMarkdownList(lines, 'Static diagnosis found', ciDiscovery.staticFound)
  appendMarkdownList(lines, 'Warnings', ciDiscovery.warnings)
  appendMarkdownList(lines, 'Contradictions', ciDiscovery.contradictions)
  appendMarkdownList(lines, 'Notes', ciDiscovery.notes)
  lines.push('')
}

function appendMarkdownStaticDiagnosisNotes (lines, notes) {
  if (!Array.isArray(notes) || notes.length === 0) return

  lines.push('## Static Diagnosis Notes', '')
  for (const note of notes) {
    lines.push(`- ${note}`)
  }
  lines.push('')
}

function appendMarkdownCiCommandCandidates (lines, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return

  lines.push('## CI Command Candidates', '')
  for (const candidate of candidates) {
    lines.push(`- ${candidate.frameworkId}: ${formatCiCommandCandidateSummary(candidate, { markdown: true })}`)
    for (const detail of formatCiCommandCandidateDetails(candidate, { markdown: true })) {
      lines.push(`  - ${detail}`)
    }
  }
  lines.push('')
}

function appendMarkdownOmittedCommands (lines, report) {
  const omitted = getStringArray(report.omitted)
  const omittedTestCommands = Array.isArray(report.omittedTestCommands) ? report.omittedTestCommands : []
  if (omitted.length === 0 && omittedTestCommands.length === 0) return

  lines.push('## Omitted Test Commands', '')
  for (const note of omitted) {
    lines.push(`- ${note}`)
  }
  for (const command of omittedTestCommands) {
    lines.push(`- ${formatOmittedTestCommand(command, { markdown: true })}`)
  }
  lines.push('')
}

function appendMarkdownResultDetails (lines, results) {
  const details = results.filter(shouldRenderResultDetails)
  if (details.length === 0) return

  lines.push('## Failed and Blocked Result Details', '')
  for (const result of details) {
    lines.push(`### ${result.status.toUpperCase()} ${result.frameworkId} ${result.scenario}`, '', result.diagnosis, '')
    for (const detail of getResultDetailLines(result, { markdown: true })) {
      lines.push(`- ${detail}`)
    }
    lines.push('')
  }
}

function appendMarkdownList (lines, label, values) {
  if (!Array.isArray(values) || values.length === 0) return
  lines.push(`- ${label}: ${values.map(value => `\`${value}\``).join(', ')}`)
}

function appendMarkdownJsonSection (lines, title, value) {
  if (value === undefined) return

  lines.push('', `## ${title}`, '', '```json', JSON.stringify(value, null, 2), '```')
}

function formatCiCommandCandidateSummary (candidate, options = {}) {
  const format = options.markdown
    ? value => `\`${value}\``
    : value => value
  const parts = [
    candidate.provider,
    candidate.workflow && `workflow ${format(candidate.workflow)}`,
    candidate.job && `job ${format(candidate.job)}`,
    candidate.step && `step ${format(candidate.step)}`,
    candidate.command && `command ${format(candidate.command)}`,
    candidate.cwd && `cwd ${format(candidate.cwd)}`,
  ].filter(Boolean)

  return parts.length > 0 ? parts.join('; ') : 'CI command metadata was not determined'
}

function formatCiCommandCandidateDetails (candidate, options = {}) {
  const details = []
  const format = options.markdown
    ? value => `\`${value}\``
    : value => value

  if (candidate.whySelected) {
    details.push(`Selected because: ${candidate.whySelected}`)
  }

  const envSummary = formatCiEnvSummary(candidate.env, { format })
  if (envSummary) {
    details.push(`Environment found in CI: ${envSummary}`)
  }

  const expansion = formatChain(candidate.packageScriptExpansionChain, { format })
  if (expansion) {
    details.push(`Package script expansion: ${expansion}`)
  }

  const toolChain = formatChain(candidate.runnerToolChain, { format })
  if (toolChain) {
    details.push(`Runner/tool chain: ${toolChain}`)
  }

  const setupCommands = formatChain(candidate.setupCommandIds, { format })
  if (setupCommands) {
    details.push(`Required setup command ids: ${setupCommands}`)
  }

  const unresolved = formatChain(candidate.unresolved, { format })
  if (unresolved) {
    details.push(`Unresolved replay details: ${unresolved}`)
  }

  const commandDetails = formatCommandDetails(candidate.commandDetails)
  if (commandDetails) {
    details.push(`Command display details: ${commandDetails}`)
  }

  return details
}

function formatCiEnvSummary (env, { format }) {
  if (!env || typeof env !== 'object') return ''

  const parts = []
  for (const scope of ['workflow', 'job', 'step', 'inherited']) {
    const values = formatEnvPairs(env[scope], { format })
    if (values) parts.push(`${scope} ${values}`)
  }
  return parts.join('; ')
}

function formatEnvPairs (env, { format }) {
  if (!env || typeof env !== 'object') return ''

  const pairs = []
  for (const [name, value] of Object.entries(env)) {
    pairs.push(format(`${name}=${value}`))
  }
  return pairs.join(', ')
}

function formatChain (values, { format }) {
  if (!Array.isArray(values) || values.length === 0) return ''
  return values.map(value => format(value)).join(' -> ')
}

function formatCommandDetails (details) {
  if (!details || typeof details !== 'object') return ''

  const parts = []
  if (details.runtimeWrapper) parts.push(`runtime wrapper ${details.runtimeWrapper}`)
  if (details.packageManager) parts.push(`package manager ${details.packageManager}`)
  if (details.pathAdjusted) parts.push('PATH adjusted')
  if (details.exactCommandCollapsed) parts.push('display command collapsed runtime plumbing')
  return parts.join('; ')
}

function shouldRenderResultDetails (result) {
  return result.status === 'fail' || result.status === 'error' || result.status === 'blocked'
}

function getResultDetailLines (result, options = {}) {
  const evidence = result.evidence || {}
  const format = options.markdown
    ? value => `\`${value}\``
    : value => value
  const lines = []
  const command = readResultCommand(result) || getEvidenceCommand(evidence)

  if (command?.command) lines.push(`Command: ${format(command.command)}`)
  if (command?.cwd) lines.push(`Cwd: ${format(command.cwd)}`)
  if (command?.exitCode !== undefined) lines.push(`Exit code: ${format(command.exitCode)}`)
  if (command?.timedOut !== undefined) lines.push(`Timed out: ${format(command.timedOut)}`)
  if (command?.durationMs !== undefined) lines.push(`Duration ms: ${format(command.durationMs)}`)

  if (Array.isArray(evidence.commandOutputSummary) && evidence.commandOutputSummary.length > 0) {
    lines.push(`Command output summary: ${formatList(evidence.commandOutputSummary, { format })}`)
  }

  if (evidence.reason) lines.push(`Reason: ${evidence.reason}`)
  if (evidence.error) lines.push(`Error: ${format(evidence.error)}`)
  if (evidence.errorCode) lines.push(`Error code: ${format(evidence.errorCode)}`)
  if (evidence.errorSyscall) lines.push(`Error syscall: ${format(evidence.errorSyscall)}`)
  if (evidence.errorAddress) lines.push(`Error address: ${format(evidence.errorAddress)}`)
  if (Array.isArray(evidence.remediation) && evidence.remediation.length > 0) {
    lines.push(`Remediation: ${formatList(evidence.remediation, { format })}`)
  }
  if (evidence.rerunCommand) lines.push(`Rerun command: ${format(evidence.rerunCommand)}`)

  appendExcerptLine(lines, 'Stdout excerpt', evidence.commandFailure?.stdoutExcerpt, { format })
  appendExcerptLine(lines, 'Stderr excerpt', evidence.commandFailure?.stderrExcerpt, { format })
  appendExcerptLine(lines, 'Debug lines', evidence.debugRerun?.debugLines, { format })
  appendExcerptLine(lines, 'Debug stdout excerpt', evidence.debugRerun?.stdoutExcerpt, { format })
  appendExcerptLine(lines, 'Debug stderr excerpt', evidence.debugRerun?.stderrExcerpt, { format })
  appendSetupFailureLines(lines, evidence, { format })
  appendEventFailureLines(lines, evidence, { format })
  appendInitializationProbeLines(lines, evidence.initializationProbe, { format })
  appendMonorepoFindingLines(lines, evidence.monorepoFindings, { format })

  if (evidence.recommendation) {
    lines.push(`Recommendation: ${evidence.recommendation}`)
  }
  if (Array.isArray(result.artifacts) && result.artifacts.length > 0) {
    lines.push(`Artifacts: ${formatList(result.artifacts, { format })}`)
  }

  return lines.length > 0 ? lines : ['No additional structured evidence was recorded.']
}

function readResultCommand (result) {
  const commandArtifact = (result.artifacts || []).find(artifact => path.basename(artifact) === 'command.json')
  if (!commandArtifact) return

  try {
    const artifact = JSON.parse(fs.readFileSync(commandArtifact, 'utf8'))
    return {
      command: sanitizeString(artifact.displayCommand || artifact.command),
      cwd: artifact.cwd,
      durationMs: artifact.durationMs,
      exitCode: artifact.exitCode,
      timedOut: artifact.timedOut,
    }
  } catch {}
}

function getEvidenceCommand (evidence) {
  const setupCommand = evidence.setupCommand
  if (!setupCommand) return

  return {
    command: sanitizeString(setupCommand.command),
    cwd: setupCommand.cwd,
    exitCode: setupCommand.exitCode,
    timedOut: setupCommand.timedOut,
  }
}

function appendExcerptLine (lines, label, values, { format }) {
  if (!Array.isArray(values) || values.length === 0) return
  lines.push(`${label}: ${formatList(values, { format })}`)
}

function appendSetupFailureLines (lines, evidence, { format }) {
  const setupCommand = evidence.setupCommand
  if (!setupCommand) return

  lines.push(`Setup failed: ${setupCommand.description || setupCommand.id || setupCommand.command}`)
  if (setupCommand.stdoutSummary) {
    lines.push(`Setup stdout excerpt: ${format(setupCommand.stdoutSummary)}`)
  }
  if (setupCommand.stderrSummary) {
    lines.push(`Setup stderr excerpt: ${format(setupCommand.stderrSummary)}`)
  }
}

function appendEventFailureLines (lines, evidence, { format }) {
  const failure = evidence.eventLevelFailure
  if (!failure) return

  if (failure.kind) lines.push(`Event failure kind: ${format(failure.kind)}`)
  if (Array.isArray(failure.missingLevels) && failure.missingLevels.length > 0) {
    lines.push(`Missing event levels: ${formatList(failure.missingLevels, { format })}`)
  }
  if (failure.recommendation) {
    lines.push(`Event recommendation: ${failure.recommendation}`)
  }
}

function appendInitializationProbeLines (lines, probe, { format }) {
  if (!probe || probe.ran !== true) return

  lines.push(`NODE_OPTIONS probe: reached Node process ${format(probe.reachedAnyNodeProcess)}, ` +
    `reached test runner ${format(probe.reachedTestRunnerProcess)}, processes ${format(probe.processCount || 0)}`)
  appendToolSignalLine(lines, 'Probe test runner signals', probe.testRunnerSignals, { format })
  appendToolSignalLine(lines, 'Probe wrapper signals', probe.wrapperSignals, { format })
  appendToolSignalLine(lines, 'Probe package manager signals', probe.packageManagerSignals, { format })
  if (probe.recordsPath) lines.push(`Probe records: ${format(probe.recordsPath)}`)
}

function appendToolSignalLine (lines, label, signals, { format }) {
  if (!Array.isArray(signals) || signals.length === 0) return

  const values = signals.map(signal => {
    const parts = [signal.name, signal.pid && `pid ${signal.pid}`, signal.cwd && `cwd ${signal.cwd}`].filter(Boolean)
    return parts.join(' ')
  })
  lines.push(`${label}: ${formatList(values, { format })}`)
}

function appendMonorepoFindingLines (lines, findings, { format }) {
  if (!Array.isArray(findings) || findings.length === 0) return

  for (const finding of findings) {
    const parts = [
      finding.id,
      finding.tool && `tool ${finding.tool}`,
      finding.reason,
      finding.recommendation && `Recommendation: ${finding.recommendation}`,
    ].filter(Boolean)
    lines.push(`Monorepo finding: ${formatList(parts, { format })}`)
  }
}

function formatOmittedTestCommand (command, options = {}) {
  const format = options.markdown
    ? value => `\`${value}\``
    : value => value
  const source = command.source || {}
  const sourceParts = [
    source.provider,
    source.file,
    source.workflow && `workflow ${source.workflow}`,
    source.job && `job ${source.job}`,
    source.step && `step ${source.step}`,
  ].filter(Boolean)
  const parts = [
    command.command && `command ${format(command.command)}`,
    command.classification && `classification ${format(command.classification)}`,
    command.reason,
    command.impact,
    sourceParts.length > 0 && `source ${sourceParts.join('; ')}`,
  ].filter(Boolean)

  return parts.join('; ')
}

function formatList (values, { format }) {
  return values.map(value => format(value)).join(', ')
}

function getKeyArtifacts (artifacts) {
  return [
    ['Markdown report', artifacts.report],
    ['Manifest', artifacts.manifest],
    ['Normalized intake payloads', artifacts.normalizedPayloads],
    ['Sanitized intake requests', artifacts.requests],
    ['Static diagnosis', artifacts.staticDiagnosis],
  ]
}

function formatFrameworkContext (framework, options = {}) {
  const format = options.markdown
    ? value => `\`${value}\``
    : value => value

  if (!framework) return `language ${format('javascript')}`

  return [
    `language ${format(framework.language || 'javascript')}`,
    `package ${format(framework.packageName || 'unknown')}`,
    `working directory ${format(framework.workingDirectory || 'unknown')}`,
    `command cwd ${format(framework.commandWorkingDirectory || 'unknown')}`,
  ].join('; ')
}

function renderConsoleSummary (results, reportPath) {
  const lines = ['', 'Datadog Test Optimization validation summary:']
  const basicReportingResults = getBasicReportingResults(results)
  const ciWiringResults = getCiWiringResults(results)
  const advancedFeatureResults = getAdvancedFeatureResults(results)
  const diagnosticResults = getDiagnosticOnlyResults(results)

  if (basicReportingResults.length > 0) {
    lines.push('Basic Reporting:')
  }
  for (const result of basicReportingResults) {
    lines.push(`${result.status.toUpperCase()} ${result.frameworkId} ${result.scenario} - ${result.diagnosis}`)
  }

  if (ciWiringResults.length > 0) {
    lines.push('CI wiring validation:')
  }
  for (const result of ciWiringResults) {
    lines.push(`${result.status.toUpperCase()} ${result.frameworkId} ${result.scenario} - ${result.diagnosis}`)
  }

  if (advancedFeatureResults.length > 0) {
    lines.push('Advanced feature validation:')
  }
  for (const result of advancedFeatureResults) {
    lines.push(`${result.status.toUpperCase()} ${result.frameworkId} ${result.scenario} - ${result.diagnosis}`)
  }

  if (diagnosticResults.length > 0) {
    lines.push('Diagnostic-only or blocked frameworks:')
  }
  for (const result of diagnosticResults) {
    lines.push(`${result.status.toUpperCase()} ${result.frameworkId} - ${result.diagnosis}`)
    appendExecutionEnvironmentRemediation(lines, result)
  }

  lines.push(
    `Detailed report: ${reportPath}`,
    `Run artifacts: ${path.dirname(reportPath)}`,
    `Sharing warning: ${SHARING_WARNING}`
  )
  return lines.join('\n')
}

function appendExecutionEnvironmentRemediation (lines, result) {
  const evidence = result.evidence || {}
  if (evidence.blockedByExecutionEnvironment !== true) return

  lines.push(
    'No Test Optimization conclusion was reached for this framework.',
    'This is not evidence that Test Optimization is misconfigured.',
    'The manifest and generated artifacts may still be useful for rerunning live validation.',
    'Rerun the validator outside the restricted sandbox.'
  )

  if (Array.isArray(evidence.remediation) && evidence.remediation.length > 0) {
    lines.push('Rerun live validation from one of:')
    for (const remediation of evidence.remediation) {
      lines.push(`- ${remediation}`)
    }
  }

  if (evidence.rerunCommand) {
    lines.push(`Command: ${evidence.rerunCommand}`)
  }
}

function getLiveValidationResults (results) {
  return results.filter(result => !isDiagnosticOnlyResult(result))
}

function getCiWiringResults (results) {
  return getLiveValidationResults(results).filter(result => result.scenario === CI_WIRING_SCENARIO)
}

function getBasicReportingResults (results) {
  return getLiveValidationResults(results).filter(result => result.scenario === 'basic-reporting')
}

function getAdvancedFeatureResults (results) {
  return getLiveValidationResults(results).filter(result => {
    return result.scenario !== CI_WIRING_SCENARIO && result.scenario !== 'basic-reporting'
  })
}

function getDiagnosticOnlyResults (results) {
  return results.filter(isDiagnosticOnlyResult)
}

function appendMarkdownResultSection (lines, title, results) {
  if (results.length === 0) return

  lines.push(`### ${title}`, '')
  for (const result of results) {
    lines.push(`- ${result.status.toUpperCase()} ${result.frameworkId} ${result.scenario}: ${result.diagnosis}`)
  }
  lines.push('')
}

function isDiagnosticOnlyResult (result) {
  if (result.scenario !== 'all') return false
  return result.evidence?.frameworkStatus ||
    result.evidence?.staticDiagnosis ||
    result.evidence?.intakeStarted === false
}

function stripPrivateFields (manifest) {
  const copy = { ...manifest }
  delete copy.__path
  return copy
}

module.exports = { writeReport }
