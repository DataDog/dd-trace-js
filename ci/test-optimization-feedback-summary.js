'use strict'

/* eslint-disable no-console */

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const {
  renderFeedbackSummary,
} = require('./test-optimization-render-report')

const DEFAULT_FEEDBACK_FILE = 'dd-test-optimization-actionable-feedback.txt'
const DEFAULT_PREEXISTING_STATUS_FILE = 'dd-test-optimization-preexisting-status.txt'
const DEFAULT_SUMMARY_FILE = 'dd-test-optimization-feedback-summary.txt'

/**
 * Parses CLI arguments.
 *
 * @param {string[]} args command-line arguments
 * @returns {object} parsed options
 */
function parseArgs (args) {
  const options = {
    feedbackFile: DEFAULT_FEEDBACK_FILE,
    feedbackSummaryOut: DEFAULT_SUMMARY_FILE,
    preexistingStatusFile: DEFAULT_PREEXISTING_STATUS_FILE,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--feedback-file') {
      options.feedbackFile = args[++i]
    } else if (arg.startsWith('--feedback-file=')) {
      options.feedbackFile = arg.slice('--feedback-file='.length)
    } else if (arg === '--out') {
      options.feedbackSummaryOut = args[++i]
    } else if (arg.startsWith('--out=')) {
      options.feedbackSummaryOut = arg.slice('--out='.length)
    } else if (arg === '--preexisting-status-file') {
      options.preexistingStatusFile = args[++i]
    } else if (arg.startsWith('--preexisting-status-file=')) {
      options.preexistingStatusFile = arg.slice('--preexisting-status-file='.length)
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      options.unknown = arg
    }
  }

  return options
}

/**
 * Gets CLI help text.
 *
 * @returns {string} help text
 */
function getHelpText () {
  return [
    'Usage: dd-trace-ci-feedback-summary [options]',
    '',
    'Renders the compact runbook feedback summary and prints the required status sections.',
    '',
    'Options:',
    `  --feedback-file <file>          Feedback file. Default: ${DEFAULT_FEEDBACK_FILE}`,
    `  --out <file>                    Summary output file. Default: ${DEFAULT_SUMMARY_FILE}`,
    `  --preexisting-status-file <file>  Preexisting status file. Default: ${DEFAULT_PREEXISTING_STATUS_FILE}`,
  ].join('\n')
}

/**
 * Renders, writes, and prints the feedback-mode response sections.
 *
 * @param {object} options summary options
 * @returns {string} rendered output
 */
function renderFeedbackSummaryOutput (options) {
  const feedbackSummary = renderFeedbackSummary(options)
  const output = [
    feedbackSummary,
    '',
    'Feedback summary path:',
    path.resolve(options.feedbackSummaryOut),
    '',
    'Pre-existing worktree changes:',
    getPreexistingStatus(options.preexistingStatusFile),
    '',
    'Current diagnostic artifacts:',
    getCurrentDiagnosticArtifacts(),
  ].join('\n')

  fs.writeFileSync(path.resolve(options.feedbackSummaryOut), `${feedbackSummary}\n`)

  return output
}

/**
 * Reads the preexisting worktree status.
 *
 * @param {string} file status file
 * @returns {string} status text
 */
function getPreexistingStatus (file) {
  try {
    const text = fs.readFileSync(path.resolve(file), 'utf8').replace(/[\r\n]+$/, '')

    return text.trim() ? text : 'none'
  } catch {
    return 'unknown'
  }
}

/**
 * Gets diagnostic artifact status lines from git status.
 *
 * @returns {string} diagnostic artifact status
 */
function getCurrentDiagnosticArtifacts () {
  const status = spawnSync('git', ['status', '--short'], { encoding: 'utf8' })

  if (status.status !== 0) return 'unknown'

  const lines = status.stdout
    .split(/\r?\n/)
    .filter(isDiagnosticStatusLine)

  return lines.length > 0 ? lines.join('\n') : 'none'
}

/**
 * Checks whether a git status line is a runbook diagnostic artifact.
 *
 * @param {string} line git status line
 * @returns {boolean} whether the line is diagnostic
 */
function isDiagnosticStatusLine (line) {
  return /^(?:\?\? (?:dd-test-optimization|dd-intake)|\?\? nohup\.out$|.. (?:dd-test-optimization|dd-intake))/.test(
    line
  )
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
      console.log(renderFeedbackSummaryOutput(options))
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  }
}

module.exports = {
  getCurrentDiagnosticArtifacts,
  getPreexistingStatus,
  isDiagnosticStatusLine,
  parseArgs,
  renderFeedbackSummaryOutput,
}
