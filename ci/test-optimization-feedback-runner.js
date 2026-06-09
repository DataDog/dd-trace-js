'use strict'

/* eslint-disable no-console */

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const {
  runFeedbackMode,
} = require('./test-optimization-debug')
const {
  restoreAdvancedChecks,
} = require('./test-optimization-prepare-advanced')
const {
  selectTestCommand,
  writeSelection,
} = require('./test-optimization-select-command')

const ARTIFACT_FILES = [
  'dd-intake-html-file-url.txt',
  'dd-intake-html-path.txt',
  'dd-intake-log-path.txt',
  'dd-intake.pid',
  'dd-intake-shutdown-url.txt',
  'dd-intake-url.txt',
  'dd-test-optimization-env.txt',
  'dd-test-optimization-advanced-validation-url.txt',
  'dd-test-optimization-efd-command.txt',
  'dd-test-optimization-efd-validation-url.txt',
  'dd-test-optimization-efd-new-test-snippet.txt',
  'dd-test-optimization-efd-temp-test-file.txt',
  'dd-test-optimization-feedback-summary.txt',
  'dd-test-optimization-feedback-wrapper.log',
  'dd-test-optimization-selected-command.input',
  'dd-test-optimization-selected-files.input',
  'dd-test-optimization-atr-flaky-test-backup.txt',
  'dd-test-optimization-atr-flaky-test-file.txt',
  'dd-test-optimization-atr-flaky-test-snippet.txt',
  'dd-test-optimization-actionable-feedback.txt',
  'dd-test-optimization-known-tests.json',
  'dd-test-optimization-advanced-dry-run.txt',
  'dd-test-optimization-agent-report.json',
  'dd-test-optimization-final-report.txt',
  'dd-test-optimization-static.json',
  'dd-test-optimization-intake.json',
  'dd-test-optimization-agent-report.txt',
  'dd-test-optimization-selected-test-files.txt',
  'dd-test-optimization-test-command.txt',
  'dd-test-optimization-test-exit-code.txt',
  'dd-test-optimization-test-output.txt',
  'dd-test-optimization-test-result.txt',
  'dd-test-optimization-validation-url.txt',
  'dd-test-optimization-full-validation-url.txt',
  'dd-test-optimization-full-advanced-validation-url.txt',
  'dd-test-optimization-report.html',
  'dd-test-optimization-root-stage.txt',
  'dd-test-optimization-summary.txt',
  'nohup.out',
]
const ARTIFACT_DIRS = [
  'dd-test-optimization-basic',
  'dd-test-optimization-efd',
]
const COMMAND_FILE = 'dd-test-optimization-test-command.txt'
const FEEDBACK_WRAPPER_LOG = 'dd-test-optimization-feedback-wrapper.log'
const PREEXISTING_STATUS_FILE = 'dd-test-optimization-preexisting-status.txt'
const SELECTED_COMMAND_INPUT = 'dd-test-optimization-selected-command.input'
const SELECTED_FILES_INPUT = 'dd-test-optimization-selected-files.input'
const SELECTED_FILES_FILE = 'dd-test-optimization-selected-test-files.txt'

/**
 * Parses CLI arguments.
 *
 * @param {string[]} args command-line arguments
 * @returns {object} parsed options
 */
function parseArgs (args) {
  const options = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--framework') {
      options.framework = args[++i]
    } else if (arg.startsWith('--framework=')) {
      options.framework = arg.slice('--framework='.length)
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
    'Usage: dd-trace-ci-feedback-runner [--framework <name>]',
    '',
    'Runs the deterministic runbook feedback path:',
    'cleanup, clean-test selection, feedback wrapper, and source cleanup verification.',
    '',
    'After this command succeeds, write dd-test-optimization-actionable-feedback.txt and run F9.',
    '',
    'Options:',
    '  --framework <name>  Force framework selection: jest, mocha, or vitest.',
  ].join('\n')
}

/**
 * Runs the deterministic feedback-mode path.
 *
 * @param {object} options runner options
 * @param {Function} callback called with an optional error
 */
function runFeedbackRunner (options, callback) {
  try {
    restoreAdvancedChecks()
    capturePreexistingStatus()
    cleanArtifacts()
    printDiscovery()
    writeSelectedCommand(options)
  } catch (error) {
    callback(error)
    return
  }

  runFeedbackModeWithLog((error) => {
    if (error) {
      callback(error)
      return
    }

    try {
      verifyPostRunCleanup()
      printCompactStatus()
    } catch (postRunError) {
      callback(postRunError)
      return
    }

    callback()
  })
}

/**
 * Captures non-diagnostic worktree status before cleaning artifacts.
 */
function capturePreexistingStatus () {
  const status = getPreexistingStatus()
  fs.writeFileSync(PREEXISTING_STATUS_FILE, `${status || 'none'}\n`)
}

/**
 * Gets non-diagnostic worktree status.
 *
 * @returns {string} filtered git status
 */
function getPreexistingStatus () {
  const result = spawnSync('git', ['status', '--short'], { encoding: 'utf8' })
  if (result.status !== 0) return 'not a git worktree'

  return result.stdout
    .split(/\r?\n/)
    .filter(line => line && !isDiagnosticStatusLine(line))
    .join('\n')
}

/**
 * Checks whether a git status line belongs to diagnostic artifacts.
 *
 * @param {string} line git status line
 * @returns {boolean} whether the line is diagnostic
 */
function isDiagnosticStatusLine (line) {
  return /^\?\? (?:dd-test-optimization|dd-intake)/.test(line) ||
    /^\?\? nohup\.out$/.test(line) ||
    /^.. (?:dd-test-optimization|dd-intake)/.test(line)
}

/**
 * Removes prior diagnostic artifacts.
 */
function cleanArtifacts () {
  const intakeLogPath = readOptionalText('dd-intake-log-path.txt')
  if (intakeLogPath) fs.rmSync(intakeLogPath, { force: true })

  for (const file of ARTIFACT_FILES) {
    fs.rmSync(path.resolve(file), { force: true })
  }

  for (const dir of ARTIFACT_DIRS) {
    fs.rmSync(path.resolve(dir), { recursive: true, force: true })
  }
}

/**
 * Prints compact repository discovery.
 */
function printDiscovery () {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'))
  const scripts = packageJson.scripts || {}
  const dependencies = getRelevantDependencies(packageJson.dependencies)
  const devDependencies = getRelevantDependencies(packageJson.devDependencies)

  console.log(JSON.stringify({
    packageManager: packageJson.packageManager,
    scripts: getScriptSummary(scripts),
    dependencies,
    devDependencies,
  }, null, 2))
  console.log('Pre-existing non-diagnostic worktree changes:')
  process.stdout.write(fs.readFileSync(PREEXISTING_STATUS_FILE, 'utf8'))
}

/**
 * Gets a compact script summary for discovery output.
 *
 * @param {object} scripts package.json scripts
 * @returns {object} compact script summary
 */
function getScriptSummary (scripts) {
  const scriptNames = Object.keys(scripts)
  const testScriptNames = scriptNames.filter(name => /^test(?::|$)/.test(name))

  return {
    count: scriptNames.length,
    test: scripts.test,
    testScripts: testScriptNames,
  }
}

/**
 * Gets dependencies relevant to test optimization setup.
 *
 * @param {object|undefined} dependencies dependency map
 * @returns {object} filtered dependency map
 */
function getRelevantDependencies (dependencies) {
  const relevant = {}

  for (const [name, version] of Object.entries(dependencies || {})) {
    if (/^(dd-trace|mocha|jest|vitest|cypress|playwright|@cucumber\/cucumber|cucumber-js)$/.test(name)) {
      relevant[name] = version
    }
  }

  return relevant
}

/**
 * Selects, writes, and validates the test command.
 *
 * @param {object} options runner options
 */
function writeSelectedCommand (options) {
  const selection = selectTestCommand({ framework: options.framework })

  writeSelection({
    commandOut: SELECTED_COMMAND_INPUT,
    filesOut: SELECTED_FILES_INPUT,
  }, selection)

  fs.writeFileSync(COMMAND_FILE, `${selection.command}\n`)
  fs.writeFileSync(SELECTED_FILES_FILE, `${selection.file}\n`)
  fs.writeFileSync('dd-test-optimization-test-result.txt', 'unknown\n')
  validateSelectedFiles([selection.file])

  console.log(`Selected test command: ${selection.command}`)
  console.log(`Selected test file: ${selection.file}`)
  console.log(`Framework: ${selection.framework}`)
  console.log(`Package manager: ${selection.packageManager}`)
}

/**
 * Validates selected test files before running the feedback wrapper.
 *
 * @param {string[]} selectedFiles selected test files
 */
function validateSelectedFiles (selectedFiles) {
  for (const file of selectedFiles) {
    if (!fs.existsSync(path.resolve(file))) {
      throw new Error(`Selected test file does not exist: ${file}`)
    }

    const result = spawnSync('git', ['status', '--short', '--', file], { encoding: 'utf8' })
    if (result.status !== 0) {
      throw new Error(`Could not verify git status for selected test file: ${file}`)
    }
    if (result.stdout.trim()) {
      throw new Error(`Selected test file has local changes: ${file}`)
    }
  }
}

/**
 * Runs the feedback wrapper while writing verbose wrapper output to a log.
 *
 * @param {Function} callback called with an optional error
 */
function runFeedbackModeWithLog (callback) {
  const stream = fs.createWriteStream(FEEDBACK_WRAPPER_LOG)
  const originalLog = console.log

  console.log = (...args) => {
    stream.write(`${args.join(' ')}\n`)
  }

  runFeedbackMode({
    feedbackMode: true,
    open: false,
    selectedTestFilesFile: SELECTED_FILES_FILE,
    service: 'dd-test-optimization-debug',
    testCommandFile: COMMAND_FILE,
  }, (error, report) => {
    console.log = originalLog

    if (report) stream.write(`${report}\n`)

    stream.end(() => {
      if (error) {
        process.stdout.write(readOptionalText(FEEDBACK_WRAPPER_LOG))
        callback(error)
        return
      }

      callback()
    })
  })
}

/**
 * Verifies temporary source edits were restored.
 */
function verifyPostRunCleanup () {
  const efdTempFile = readAdvancedDryRunValue('Temporary EFD test file: ')

  if (efdTempFile) {
    if (fs.existsSync(path.resolve(efdTempFile))) {
      throw new Error(`Temporary EFD file still exists: ${efdTempFile}`)
    }
    console.log(`Temporary EFD file absent: ${efdTempFile}`)
  }

  const selectedFiles = readSelectedFiles()
  for (const file of selectedFiles) {
    assertNoDiff(file)
  }

  if (selectedFiles.length > 0) {
    console.log('Selected source files are clean after feedback-mode wrapper.')
  }

  for (const stateFile of [
    'dd-test-optimization-efd-temp-test-file.txt',
    'dd-test-optimization-atr-flaky-test-file.txt',
    'dd-test-optimization-atr-flaky-test-backup.txt',
  ]) {
    if (fs.existsSync(path.resolve(stateFile))) {
      throw new Error(`Temporary state file still exists: ${stateFile}`)
    }
  }
}

/**
 * Prints compact feedback runner status.
 */
function printCompactStatus () {
  const root = readJson('dd-test-optimization-agent-report.json')
  const advanced = readJson(path.join('dd-test-optimization-efd', 'dd-test-optimization-agent-report.json'))

  console.log(`Root wrapper stage: ${root.primaryStage || 'unknown'}`)
  console.log(`Root requests: ${root.summary?.requestCount ?? 'unknown'}`)
  console.log(`Advanced checks: ${advanced.primaryStage || 'unknown'}`)
  console.log(`EFD retried new tests: ${advanced.summary?.efd?.retriedNewTests ?? 'unknown'}`)
  console.log(
    `Auto Test Retries flaky tests reported: ${advanced.summary?.atr?.failedThenPassedRetryTests ?? 'unknown'}`
  )
  console.log(`Wrapper log: ${path.resolve(FEEDBACK_WRAPPER_LOG)}`)
  console.log('Write dd-test-optimization-actionable-feedback.txt, then run F9.')
}

/**
 * Asserts no unstaged or staged diff exists for a selected file.
 *
 * @param {string} file selected file
 */
function assertNoDiff (file) {
  const unstaged = spawnSync('git', ['diff', '--exit-code', '--', file], { encoding: 'utf8' })
  if (unstaged.status !== 0) {
    throw new Error(`Selected file has unstaged changes after feedback wrapper: ${file}`)
  }

  const staged = spawnSync('git', ['diff', '--cached', '--exit-code', '--', file], { encoding: 'utf8' })
  if (staged.status !== 0) {
    throw new Error(`Selected file has staged changes after feedback wrapper: ${file}`)
  }
}

/**
 * Reads selected files from the state file.
 *
 * @returns {string[]} selected files
 */
function readSelectedFiles () {
  return readOptionalText(SELECTED_FILES_FILE)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
}

/**
 * Reads a value from the advanced dry-run artifact.
 *
 * @param {string} prefix line prefix
 * @returns {string|undefined} value
 */
function readAdvancedDryRunValue (prefix) {
  const text = readOptionalText('dd-test-optimization-advanced-dry-run.txt')
  const line = text.split(/\r?\n/).find(line => line.startsWith(prefix))

  return line ? line.slice(prefix.length).trim() : undefined
}

/**
 * Reads optional text.
 *
 * @param {string} file file path
 * @returns {string} file text or an empty string
 */
function readOptionalText (file) {
  try {
    return fs.readFileSync(path.resolve(file), 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * Reads JSON.
 *
 * @param {string} file file path
 * @returns {object} parsed JSON
 */
function readJson (file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
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
    runFeedbackRunner(options, (error) => {
      if (!error) return

      console.error(error.message)
      process.exitCode = 1
    })
  }
}

module.exports = {
  cleanArtifacts,
  getPreexistingStatus,
  getScriptSummary,
  isDiagnosticStatusLine,
  parseArgs,
  runFeedbackRunner,
}
