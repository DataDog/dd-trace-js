'use strict'

/* eslint-disable no-console */

const fs = require('node:fs')
const path = require('node:path')

/**
 * Reads optional JSON from disk.
 *
 * @param {string} file file path
 * @param {object} [fallback] fallback value
 * @returns {object} parsed JSON or fallback
 */
function readJson (file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * Reads optional text from disk.
 *
 * @param {string} file file path
 * @param {string} [fallback] fallback value
 * @returns {string} file text or fallback
 */
function readText (file, fallback = 'unknown') {
  try {
    return fs.readFileSync(path.resolve(file), 'utf8').trim() || fallback
  } catch {
    return fallback
  }
}

/**
 * Reads a prefixed line from a final report.
 *
 * @param {string} file report path
 * @param {string} prefix line prefix
 * @returns {string} line value or unknown
 */
function readReportLine (file, prefix) {
  const text = readText(file, '')
  const line = text.split(/\r?\n/).find(line => line.startsWith(prefix))

  return line ? line.slice(prefix.length).trim() : 'unknown'
}

/**
 * Gets formatted static finding lines.
 *
 * @param {object} staticReport static diagnosis report
 * @returns {string} static finding text
 */
function getStaticErrors (staticReport) {
  const findings = []
  const seen = new Set()

  for (const result of staticReport.results || []) {
    if (result.status !== 'error') continue

    const text = `${result.status}: ${result.title}`
    if (seen.has(text)) continue

    seen.add(text)
    findings.push(text)
  }

  return findings.join('; ') || 'none'
}

/**
 * Formats a stage status for concise console output.
 *
 * @param {string} status raw status
 * @returns {string} formatted status
 */
function formatStageStatus (status) {
  if (status === 'passed') return 'OK'
  if (status === 'not run') return 'not run'
  if (status.startsWith('failed:')) return `failed (${status.slice('failed:'.length).trim()})`

  return status
}

/**
 * Gets basic reporting status.
 *
 * @param {object} basic basic analyzer report
 * @param {object} diagnosis wrapper diagnosis
 * @returns {string} status text
 */
function getReportingStatus (basic, diagnosis) {
  const stage = basic.primaryStage || diagnosis.primaryStage || 'not run'
  return stage === 'Reporting complete' ? 'OK' : `failed (${stage})`
}

/**
 * Gets EFD status text.
 *
 * @param {object} efd advanced analyzer report
 * @returns {string} status text
 */
function getEfdStatus (efd) {
  if (efd.summary?.efd?.retriedNewTests > 0) return 'passed'
  if (efd.primaryStage) return 'failed'

  return 'not run'
}

/**
 * Gets Auto Test Retries status text.
 *
 * @param {object} efd advanced analyzer report
 * @returns {string} status text
 */
function getAtrStatus (efd) {
  if (efd.summary?.atr?.failedThenPassedRetryTests > 0) return 'passed'
  if (efd.primaryStage) return 'failed'

  return 'not run'
}

/**
 * Gets Test Management status text across all modes.
 *
 * @param {object[]} reports Test Management analyzer reports
 * @returns {string} status text
 */
function getTestManagementStatus (reports) {
  const present = reports.filter(report => report.primaryStage)
  if (present.length === 0) return 'not run'

  const statuses = [
    reports[0].summary?.tm?.disabled?.status,
    reports[1].summary?.tm?.quarantined?.status,
    reports[2].summary?.tm?.attemptToFix?.status,
  ]

  if (statuses.every(status => status === 'passed')) return 'passed'
  if (statuses.includes('passed')) return 'partial'

  return 'failed'
}

/**
 * Gets concise finding lines.
 *
 * @param {object} basic basic analyzer report
 * @param {object} diagnosis wrapper diagnosis
 * @returns {string[]} finding lines
 */
function getFindingLines (basic, diagnosis) {
  const lines = []

  for (const finding of basic.findings || []) {
    lines.push(`- ${finding.status}: ${finding.stage} - ${finding.observation}`)
  }

  if (diagnosis.likelyFailureCause) {
    lines.push(`- error: Likely failure cause - ${diagnosis.likelyFailureCause}`)
  }

  return lines.length === 0 ? ['- none'] : lines
}

/**
 * Gets concise proof text.
 *
 * @param {object} basic basic analyzer report
 * @param {string} efdStatus EFD status
 * @param {string} atrStatus Auto Test Retries status
 * @param {string} tmStatus Test Management status
 * @returns {string} proof text
 */
function getProofText (basic, efdStatus, atrStatus, tmStatus) {
  if (
    basic.primaryStage === 'Reporting complete' &&
    efdStatus === 'passed' &&
    atrStatus === 'passed' &&
    tmStatus === 'passed'
  ) {
    return 'The selected test subset reports basic Test Optimization events and validates EFD, Auto Test ' +
      'Retries, and Test Management against the local fake intake.'
  }

  if (basic.primaryStage === 'Reporting complete') {
    return 'The selected test subset reports session, module, suite, and test events to the local fake intake.'
  }

  return 'The selected run produced diagnostic evidence for the stage shown above.'
}

/**
 * Prints the final runbook extraction.
 */
function main () {
  const basic = readJson('dd-test-optimization-agent-report.json', {})
  const efd = readJson('dd-test-optimization-efd/dd-test-optimization-agent-report.json', {})
  const tmDisabled = readJson('dd-test-optimization-tm-disabled/dd-test-optimization-agent-report.json', {})
  const tmQuarantined = readJson('dd-test-optimization-tm-quarantined/dd-test-optimization-agent-report.json', {})
  const tmAttemptToFix = readJson('dd-test-optimization-tm-attempt-to-fix/dd-test-optimization-agent-report.json', {})
  const staticReport = readJson('dd-test-optimization-static.json', { results: [] })
  const diagnosis = readJson('dd-test-optimization-diagnosis.json', {})
  const efdStatus = getEfdStatus(efd)
  const atrStatus = getAtrStatus(efd)
  const tmStatus = getTestManagementStatus([tmDisabled, tmQuarantined, tmAttemptToFix])

  console.log(`HTML report: ${readText('dd-intake-html-file-url.txt', readReportLine(
    'dd-test-optimization-final-report.txt',
    'HTML report:'
  ))}`)
  console.log(readText('dd-test-optimization-validation-url.txt', `Datadog validation: ${readReportLine(
    'dd-test-optimization-final-report.txt',
    'Datadog validation:'
  )}`))
  console.log('')
  console.log('Scope:')
  console.log('- Selected test subset only.')
  console.log('- Local fake intake; no real API key.')
  console.log('')
  console.log('Summary:')
  console.log(`- Reporting: ${getReportingStatus(basic, diagnosis)}`)
  console.log(`- EFD: ${formatStageStatus(efdStatus)}`)
  console.log(`- Auto Test Retries: ${formatStageStatus(atrStatus)}`)
  console.log(`- Test Management: ${formatStageStatus(tmStatus)}`)
  console.log('')
  console.log('Findings:')
  for (const line of getFindingLines(basic, diagnosis)) console.log(line)
  console.log('')
  console.log(`Static diagnosis errors: ${getStaticErrors(staticReport)}`)
  console.log('')
  console.log('Test command used:')
  console.log(readText('dd-test-optimization-test-command.txt'))
  console.log('')
  console.log('What this proves:')
  console.log(`- ${getProofText(basic, efdStatus, atrStatus, tmStatus)}`)
}

if (require.main === module) {
  main()
}

module.exports = {
  main,
}
