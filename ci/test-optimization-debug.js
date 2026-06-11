#!/usr/bin/env node
'use strict'

/* eslint-disable no-console, eslint-rules/eslint-process-env */

const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const {
  runDiagnosis,
} = require('./diagnose')
const {
  openHtmlReport,
} = require('./test-optimization-analyze-intake')
const {
  analyzeIntakeArtifact,
  buildKnownTestsFromArtifact,
  renderAnalysisText,
} = require('./test-optimization-intake-analysis')
const {
  getPreparePlan,
  prepareAdvancedChecks,
  restoreAdvancedChecks,
} = require('./test-optimization-prepare-advanced')
const {
  getEfdExecutionDiagnostics,
  renderFinalReport,
  renderSummaryReport,
} = require('./test-optimization-render-report')
const {
  normalizeKnownTests,
  normalizeTestManagementTests,
  startIntake,
  stopIntake,
} = require('./test-optimization-intake')

const ARTIFACTS = {
  agentJsonReport: 'dd-test-optimization-agent-report.json',
  agentReport: 'dd-test-optimization-agent-report.txt',
  env: 'dd-test-optimization-env.txt',
  finalReport: 'dd-test-optimization-final-report.txt',
  html: 'dd-test-optimization-report.html',
  intake: 'dd-test-optimization-intake.json',
  static: 'dd-test-optimization-static.json',
  summary: 'dd-test-optimization-summary.txt',
  testCommand: 'dd-test-optimization-test-command.txt',
  testExitCode: 'dd-test-optimization-test-exit-code.txt',
  testOutput: 'dd-test-optimization-test-output.txt',
  testResult: 'dd-test-optimization-test-result.txt',
}
const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}${String.raw`\[[0-?]*[ -/]*[@-~]`}`, 'g')
const FEEDBACK_ARTIFACTS = {
  advancedDryRun: 'dd-test-optimization-advanced-dry-run.txt',
  basicDir: 'dd-test-optimization-basic',
  efdDir: 'dd-test-optimization-efd',
  efdCommand: 'dd-test-optimization-efd-command.txt',
  knownTests: 'dd-test-optimization-known-tests.json',
  rootStage: 'dd-test-optimization-root-stage.txt',
  selectedTestFiles: 'dd-test-optimization-selected-test-files.txt',
}
const DEFAULT_READY_TIMEOUT_MS = 5000
const READY_RETRY_INTERVAL_MS = 50

/**
 * Parses CLI arguments.
 *
 * @param {string[]} args command-line arguments
 * @returns {object} parsed options
 */
function parseArgs (args) {
  const options = {
    clean: true,
    open: true,
    service: 'dd-test-optimization-debug',
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--feedback-mode') {
      options.feedbackMode = true
    } else if (arg === '--test-command') {
      options.testCommand = args[++i]
    } else if (arg.startsWith('--test-command=')) {
      options.testCommand = arg.slice('--test-command='.length)
    } else if (arg === '--test-command-file') {
      options.testCommandFile = args[++i]
    } else if (arg.startsWith('--test-command-file=')) {
      options.testCommandFile = arg.slice('--test-command-file='.length)
    } else if (arg === '--selected-test-files-file') {
      options.selectedTestFilesFile = args[++i]
    } else if (arg.startsWith('--selected-test-files-file=')) {
      options.selectedTestFilesFile = arg.slice('--selected-test-files-file='.length)
    } else if (arg === '--service') {
      options.service = args[++i]
    } else if (arg.startsWith('--service=')) {
      options.service = arg.slice('--service='.length)
    } else if (arg === '--out-dir') {
      options.outDir = args[++i]
    } else if (arg.startsWith('--out-dir=')) {
      options.outDir = arg.slice('--out-dir='.length)
    } else if (arg === '--ready-timeout-ms') {
      options.readyTimeoutMs = Number(args[++i])
    } else if (arg.startsWith('--ready-timeout-ms=')) {
      options.readyTimeoutMs = Number(arg.slice('--ready-timeout-ms='.length))
    } else if (arg === '--settings-mode') {
      options.settingsMode = args[++i]
    } else if (arg.startsWith('--settings-mode=')) {
      options.settingsMode = arg.slice('--settings-mode='.length)
    } else if (arg === '--known-tests') {
      options.knownTests = normalizeKnownTests(readJsonFile(args[++i]))
    } else if (arg.startsWith('--known-tests=')) {
      options.knownTests = normalizeKnownTests(readJsonFile(arg.slice('--known-tests='.length)))
    } else if (arg === '--test-management-tests') {
      options.testManagementTests = normalizeTestManagementTests(readJsonFile(args[++i]))
    } else if (arg.startsWith('--test-management-tests=')) {
      options.testManagementTests = normalizeTestManagementTests(
        readJsonFile(arg.slice('--test-management-tests='.length))
      )
    } else if (arg === '--new-test-snippet-file') {
      options.newTestSnippetFile = args[++i]
    } else if (arg.startsWith('--new-test-snippet-file=')) {
      options.newTestSnippetFile = arg.slice('--new-test-snippet-file='.length)
    } else if (arg === '--flaky-test-snippet-file') {
      options.flakyTestSnippetFile = args[++i]
    } else if (arg.startsWith('--flaky-test-snippet-file=')) {
      options.flakyTestSnippetFile = arg.slice('--flaky-test-snippet-file='.length)
    } else if (arg === '--no-clean') {
      options.clean = false
    } else if (arg === '--no-open') {
      options.open = false
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
    'Usage: dd-trace-ci-debug (--test-command <command> | --test-command-file <file>) ' +
      '[--service <name>] [--out-dir <dir>]',
    '',
    'Runs the Test Optimization debug flow end-to-end:',
    'static diagnosis, local fake intake, selected test command, analyzer, and final report.',
    '',
    'Options:',
    '  --test-command <command>  Exact test command to run, for example "npm test -- test/foo.spec.js".',
    '  --test-command-file <file>  Read the exact selected test command from a file.',
    '  --feedback-mode          Run root, baseline, and advanced feedback checks with restore safety.',
    '  --selected-test-files-file <file>  Newline-delimited selected test files for --feedback-mode.',
    '  --service <name>          DD_SERVICE value for the debug run. Defaults to dd-test-optimization-debug.',
    '  --out-dir <dir>           Artifact directory. Defaults to the current directory.',
    '  --ready-timeout-ms <ms>   Time to wait for the fake intake /health endpoint. Defaults to 5000.',
    '  --settings-mode <mode>    Fake settings mode: basic-reporting, atr, efd, debug-all, or tm-*.',
    '  --known-tests <file>      Known tests JSON to return for EFD/debug runs.',
    '  --test-management-tests <file>  Test Management modules JSON to return for tm-* runs.',
    '  --new-test-snippet-file <file>  Temporary test snippet used for EFD.',
    '  --flaky-test-snippet-file <file>  Temporary flaky test snippet used for Auto Test Retries.',
    '  --no-clean                Keep prior debug artifacts before running.',
    '  --no-open                 Skip the best-effort local HTML open attempt.',
  ].join('\n')
}

/**
 * Runs the wrapper.
 *
 * @param {object} options wrapper options
 * @param {Function} callback called with (error, report)
 */
function runDebug (options, callback) {
  const root = process.cwd()
  const outDir = path.resolve(options.outDir || '.')
  const artifacts = getArtifactPaths(outDir)
  let testCommand

  try {
    testCommand = readTextValue(options.testCommand, options.testCommandFile, 'test command')
  } catch (error) {
    callback(error)
    return
  }

  if (!testCommand) {
    callback(new Error('Missing --test-command or --test-command-file.'))
    return
  }

  if (options.clean) {
    cleanArtifacts(artifacts)
  }

  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(artifacts.testCommand, `${testCommand}\n`)

  const staticReport = runDiagnosis({ root })
  fs.writeFileSync(artifacts.static, `${JSON.stringify(staticReport, null, 2)}\n`)

  startIntake({
    knownTests: options.knownTests,
    out: artifacts.intake,
    html: artifacts.html,
    settingsMode: options.settingsMode,
    testManagementTests: options.testManagementTests,
  }, (startError, intake) => {
    if (startError) {
      callback(startError)
      return
    }

    const env = getTestEnv({ ...options, testCommand }, intake, staticReport)
    const readyTimeoutMs = getReadyTimeoutMs(options)
    writeEnvFile(artifacts.env, env)

    waitForIntakeReady(intake.url, readyTimeoutMs, (readyError) => {
      if (readyError) {
        stopIntake(intake, () => {
          callback(readyError)
        })
        return
      }

      runTestCommand(testCommand, root, env, (result) => {
        const output = `${result.stdout || ''}${result.stderr || ''}`
        fs.writeFileSync(artifacts.testOutput, output)
        fs.writeFileSync(artifacts.testExitCode, `${getSpawnExitCode(result)}\n`)
        fs.writeFileSync(artifacts.testResult, `${getTestResult(output)}\n`)

        if (output && !options.silent) {
          console.log(output.trimEnd())
        }

        stopIntake(intake, () => {
          const intakeArtifact = JSON.parse(fs.readFileSync(artifacts.intake, 'utf8'))
          const analysis = analyzeIntakeArtifact(intakeArtifact)
          const newTestSnippet = readOptionalTextFile(options.newTestSnippetFile)
          const newTestFile = readOptionalTextFile('dd-test-optimization-efd-temp-test-file.txt')
          const efdExecution = getEfdExecutionDiagnostics(analysis, {
            newTestFile,
            newTestSnippet,
            testCommand,
            testOutput: output,
          })

          if (efdExecution) analysis.summary.efd.execution = efdExecution

          const openAttempt = options.open ? openHtmlReport(analysis) : undefined
          let analyzerText = renderAnalysisText(analysis)

          if (openAttempt) {
            analyzerText = `${analyzerText}\n\n${openAttempt}`
          }

          fs.writeFileSync(artifacts.agentReport, `${analyzerText}\n`)
          fs.writeFileSync(artifacts.agentJsonReport, `${JSON.stringify({
            ...analysis,
            openAttempt,
          }, null, 2)}\n`)

          const reportOptions = {
            agentJsonReport: artifacts.agentJsonReport,
            agentReport: artifacts.agentReport,
            envFile: artifacts.env,
            intake: artifacts.intake,
            out: artifacts.finalReport,
            summaryOut: artifacts.summary,
            static: artifacts.static,
            testCommandFile: artifacts.testCommand,
            testExitCodeFile: artifacts.testExitCode,
            testOutputFile: artifacts.testOutput,
            testResultFile: artifacts.testResult,
            flakyTestSnippetFile: options.flakyTestSnippetFile,
            newTestFile,
            newTestSnippetFile: options.newTestSnippetFile,
          }
          const finalReport = renderFinalReport(reportOptions)
          const summaryReport = renderSummaryReport(reportOptions)

          fs.writeFileSync(artifacts.finalReport, `${finalReport}\n`)
          fs.writeFileSync(artifacts.summary, `${summaryReport}\n`)
          callback(undefined, finalReport)
        })
      })
    })
  })
}

/**
 * Runs the coding-agent feedback flow after command discovery.
 *
 * @param {object} options feedback-mode options
 * @param {Function} callback called with (error, report)
 */
function runFeedbackMode (options, callback) {
  let selectedTestFiles

  try {
    selectedTestFiles = readSelectedTestFiles(options.selectedTestFilesFile)
    validateSelectedTestFiles(selectedTestFiles)
    fs.writeFileSync(FEEDBACK_ARTIFACTS.selectedTestFiles, `${selectedTestFiles.join('\n')}\n`)
  } catch (error) {
    callback(error)
    return
  }

  runDebug(getFeedbackDebugOptions(options), (rootError, rootReport) => {
    if (rootError) {
      callback(rootError)
      return
    }

    console.log(rootReport)

    const rootStage = getRootStage()

    fs.writeFileSync(FEEDBACK_ARTIFACTS.rootStage, `${rootStage}\n`)
    console.log(`Root wrapper stage: ${rootStage}`)

    if (rootStage !== 'Reporting complete') {
      callback(undefined, getFeedbackModeSummary(rootStage, false))
      return
    }

    runDebug(getFeedbackDebugOptions(options, { outDir: FEEDBACK_ARTIFACTS.basicDir }), (basicError, basicReport) => {
      if (basicError) {
        callback(basicError)
        return
      }

      console.log(basicReport)

      try {
        writeKnownTestsFromBaseline()
        dryRunAdvancedChecks(selectedTestFiles)
        prepareAdvancedChecks({ auto: true })
      } catch (error) {
        restoreAdvancedChecksAfterFailure(error, callback)
        return
      }

      runDebug(getFeedbackDebugOptions(options, {
        flakyTestSnippetFile: 'dd-test-optimization-atr-flaky-test-snippet.txt',
        knownTests: normalizeKnownTests(readJsonFile(FEEDBACK_ARTIFACTS.knownTests)),
        newTestSnippetFile: 'dd-test-optimization-efd-new-test-snippet.txt',
        outDir: FEEDBACK_ARTIFACTS.efdDir,
        settingsMode: 'debug-all',
        testCommand: undefined,
        testCommandFile: FEEDBACK_ARTIFACTS.efdCommand,
      }), (advancedError, advancedReport) => {
        let restoreError

        try {
          restoreAdvancedChecks()
        } catch (error) {
          restoreError = error
        }

        if (advancedError) {
          callback(advancedError)
          return
        }

        if (restoreError) {
          callback(restoreError)
          return
        }

        console.log(advancedReport)

        try {
          assertAdvancedFeedbackEvidence()
        } catch (error) {
          callback(error)
          return
        }

        callback(undefined, getFeedbackModeSummary(rootStage, true))
      })
    })
  })
}

/**
 * Gets wrapper options for one feedback-mode wrapper run.
 *
 * @param {object} options feedback-mode options
 * @param {object|undefined} overrides wrapper option overrides
 * @returns {object} wrapper options
 */
function getFeedbackDebugOptions (options, overrides) {
  return {
    ...options,
    clean: true,
    feedbackMode: false,
    open: false,
    ...overrides,
  }
}

/**
 * Reads selected test files.
 *
 * @param {string|undefined} file selected test files file
 * @returns {string[]} selected test files
 */
function readSelectedTestFiles (file) {
  if (!file) throw new Error('Missing --selected-test-files-file.')

  const selectedTestFiles = fs.readFileSync(path.resolve(file), 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

  if (selectedTestFiles.length === 0) {
    throw new Error('Selected test files file is empty.')
  }

  return selectedTestFiles
}

/**
 * Validates selected test files before temporary edits are inferred.
 *
 * @param {string[]} selectedTestFiles selected test files
 */
function validateSelectedTestFiles (selectedTestFiles) {
  for (const file of selectedTestFiles) {
    if (!fs.existsSync(file)) {
      throw new Error(`Selected test file does not exist: ${file}`)
    }

    const gitStatus = spawnSync('git', ['status', '--short', '--', file], { encoding: 'utf8' })

    if (gitStatus.status === 0 && gitStatus.stdout.trim()) {
      throw new Error(`Selected test file has local changes: ${file}`)
    }

    if (gitStatus.status !== 0) {
      throw new Error(`Could not verify git status for selected test file: ${file}`)
    }
  }
}

/**
 * Gets the root wrapper stage from the root analyzer artifact.
 *
 * @returns {string} root stage
 */
function getRootStage () {
  const report = readJsonFile(ARTIFACTS.agentJsonReport)

  return report.primaryStage || 'unknown'
}

/**
 * Writes known tests from the baseline feedback run.
 */
function writeKnownTestsFromBaseline () {
  const baselineIntake = readJsonFile(path.join(FEEDBACK_ARTIFACTS.basicDir, ARTIFACTS.intake))
  const knownTests = buildKnownTestsFromArtifact(baselineIntake)

  fs.writeFileSync(FEEDBACK_ARTIFACTS.knownTests, `${JSON.stringify(knownTests, null, 2)}\n`)
}

/**
 * Prints and validates inferred advanced-check edits.
 *
 * @param {string[]} selectedTestFiles selected test files
 */
function dryRunAdvancedChecks (selectedTestFiles) {
  const plan = getPreparePlan({ auto: true })
  const { prepareOptions } = plan
  const dryRunText = [
    'Advanced helper dry run:',
    `Temporary EFD test file: ${prepareOptions.efdTestFile}`,
    `Auto Test Retries flaky test file: ${prepareOptions.flakyTestFile}`,
    `Auto Test Retries flaky test name: ${prepareOptions.flakyTestName}`,
    `Framework: ${prepareOptions.framework}`,
    `EFD test command: ${prepareOptions.efdCommand}`,
    'No files written.',
  ].join('\n')

  fs.writeFileSync(FEEDBACK_ARTIFACTS.advancedDryRun, `${dryRunText}\n`)
  console.log(dryRunText)
  assertAdvancedPlanMatchesSelectedFiles(prepareOptions, selectedTestFiles)
  console.log('Advanced dry-run guardrails: passed')
}

/**
 * Validates inferred advanced-check targets against selected test files.
 *
 * @param {object} prepareOptions inferred advanced-check options
 * @param {string[]} selectedTestFiles selected test files
 */
function assertAdvancedPlanMatchesSelectedFiles (prepareOptions, selectedTestFiles) {
  const selectedFiles = selectedTestFiles.map(file => path.normalize(file))
  const selectedDirs = new Set(selectedFiles.map(file => path.dirname(file)))
  const efdFile = path.normalize(prepareOptions.efdTestFile)
  const flakyFile = path.normalize(prepareOptions.flakyTestFile)

  if (!selectedDirs.has(path.dirname(efdFile))) {
    throw new Error(`Temporary EFD file is not under a selected test directory: ${efdFile}`)
  }

  if (fs.existsSync(efdFile)) {
    throw new Error(`Temporary EFD file already exists: ${efdFile}`)
  }

  if (!selectedFiles.includes(flakyFile)) {
    throw new Error(`Auto Test Retries flaky file is not one of the selected test files: ${flakyFile}`)
  }
}

/**
 * Restores advanced edits after a preparation failure.
 *
 * @param {Error} originalError original failure
 * @param {Function} callback called with the original failure
 */
function restoreAdvancedChecksAfterFailure (originalError, callback) {
  try {
    restoreAdvancedChecks()
  } catch (restoreError) {
    console.error(`Advanced edit restore failed after error: ${restoreError.message}`)
  }

  callback(originalError)
}

/**
 * Asserts advanced feedback-mode evidence.
 */
function assertAdvancedFeedbackEvidence () {
  const report = readJsonFile(path.join(FEEDBACK_ARTIFACTS.efdDir, ARTIFACTS.agentJsonReport))

  assertFeedbackEvidence(report.summary.efd.settingsEnabled, 'EFD settings were not enabled.')
  assertFeedbackEvidence(report.summary.efd.requested, 'Known tests were not requested.')
  assertFeedbackEvidence(report.summary.efd.knownTestsReceived > 0, 'Known tests response was empty.')
  assertFeedbackEvidence(
    report.summary.efd.retriedNewTests > 0,
    `No new test was retried by EFD. ${report.summary.efd.execution?.diagnosis || ''}`.trim()
  )
  assertFeedbackEvidence(report.summary.atr.settingsEnabled, 'Auto Test Retries settings were not enabled.')
  assertFeedbackEvidence(report.summary.atr.failedExecutions > 0, 'No failing execution was reported.')
  assertFeedbackEvidence(report.summary.atr.passedExecutions > 0, 'No passing execution was reported.')
  assertFeedbackEvidence(report.summary.atr.passedRetryTests > 0, 'No passing retry execution was reported.')
  assertFeedbackEvidence(
    report.summary.atr.failedThenPassedRetryTests > 0,
    'No known flaky test failed and passed on retry.'
  )

  console.log(`EFD retried new tests: ${report.summary.efd.retriedNewTests}`)
  console.log(`Auto Test Retries flaky tests reported: ${report.summary.atr.failedThenPassedRetryTests}`)
}

/**
 * Asserts a feedback-mode evidence condition.
 *
 * @param {boolean} condition assertion condition
 * @param {string} message failure message
 */
function assertFeedbackEvidence (condition, message) {
  if (condition) return

  throw new Error(message)
}

/**
 * Gets a short feedback-mode completion summary.
 *
 * @param {string} rootStage root wrapper stage
 * @param {boolean} advancedRan whether advanced checks ran
 * @returns {string} summary text
 */
function getFeedbackModeSummary (rootStage, advancedRan) {
  return [
    'Feedback mode completed.',
    `Root wrapper stage: ${rootStage}`,
    `Advanced checks: ${advancedRan ? 'completed' : 'skipped'}`,
    'Write dd-test-optimization-actionable-feedback.txt, then run F9 to render the feedback summary.',
  ].join('\n')
}

/**
 * Reads a text value from an inline option or file option.
 *
 * @param {string|undefined} value inline value
 * @param {string|undefined} file text file path
 * @param {string} name value name
 * @returns {string|undefined} text value
 */
function readTextValue (value, file, name) {
  if (value !== undefined) return String(value).trim()
  if (!file) return

  const text = fs.readFileSync(path.resolve(file), 'utf8').trim()
  if (!text) throw new Error(`Missing ${name}.`)

  return text
}

/**
 * Reads a JSON file.
 *
 * @param {string} file JSON file path
 * @returns {unknown} parsed JSON
 */
function readJsonFile (file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
}

/**
 * Reads an optional text file.
 *
 * @param {string|undefined} file text file path
 * @returns {string} file text or empty string
 */
function readOptionalTextFile (file) {
  if (!file) return ''

  try {
    return fs.readFileSync(path.resolve(file), 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * Gets the fake intake readiness timeout.
 *
 * @param {object} options wrapper options
 * @returns {number} readiness timeout in milliseconds
 */
function getReadyTimeoutMs (options) {
  if (Number.isFinite(options.readyTimeoutMs) && options.readyTimeoutMs > 0) {
    return options.readyTimeoutMs
  }

  return DEFAULT_READY_TIMEOUT_MS
}

/**
 * Waits until the fake intake can handle loopback requests.
 *
 * @param {string} baseUrl intake base URL
 * @param {number} timeoutMs readiness timeout in milliseconds
 * @param {Function} callback called with an error when readiness fails
 */
function waitForIntakeReady (baseUrl, timeoutMs, callback) {
  const deadline = Date.now() + timeoutMs
  const healthUrl = new URL('/health', baseUrl)

  poll()

  function poll () {
    let settled = false
    const req = http.get(healthUrl, res => {
      res.resume()
      res.once('end', () => {
        if (res.statusCode === 200) {
          finish()
        } else {
          retry(new Error(`status ${res.statusCode}`))
        }
      })
    })

    req.setTimeout(Math.min(1000, timeoutMs), () => {
      req.destroy(new Error('request timed out'))
    })
    req.once('error', retry)

    function finish () {
      if (settled) return
      settled = true
      callback()
    }

    function retry (error) {
      if (settled) return
      settled = true

      if (Date.now() >= deadline) {
        callback(new Error(`Fake intake did not become ready at ${healthUrl.href}: ${error.message}`))
        return
      }

      setTimeout(poll, READY_RETRY_INTERVAL_MS)
    }
  }
}

/**
 * Runs the selected test command while keeping the wrapper event loop free for the fake intake.
 *
 * @param {string} testCommand selected test command
 * @param {string} cwd working directory
 * @param {object} env environment overrides
 * @param {Function} callback called with a child-process-like result
 */
function runTestCommand (testCommand, cwd, env, callback) {
  const child = spawn(testCommand, {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = []
  const stderr = []
  let called = false

  child.stdout.on('data', chunk => {
    stdout.push(chunk)
  })
  child.stderr.on('data', chunk => {
    stderr.push(chunk)
  })
  child.once('error', error => {
    finish({
      error,
      stderr: `${Buffer.concat(stderr).toString('utf8')}${error.message}\n`,
      stdout: Buffer.concat(stdout).toString('utf8'),
    })
  })
  child.once('close', (status, signal) => {
    finish({
      signal,
      status,
      stderr: Buffer.concat(stderr).toString('utf8'),
      stdout: Buffer.concat(stdout).toString('utf8'),
    })
  })

  function finish (result) {
    if (called) return
    called = true
    callback(result)
  }
}

/**
 * Gets artifact paths.
 *
 * @param {string} outDir artifact directory
 * @returns {object} artifact paths
 */
function getArtifactPaths (outDir) {
  const artifacts = {}

  for (const [key, file] of Object.entries(ARTIFACTS)) {
    artifacts[key] = path.join(outDir, file)
  }

  return artifacts
}

/**
 * Removes prior artifacts.
 *
 * @param {object} artifacts artifact paths
 */
function cleanArtifacts (artifacts) {
  for (const file of Object.values(artifacts)) {
    fs.rmSync(file, { force: true })
  }
}

/**
 * Gets the test process environment.
 *
 * @param {object} options wrapper options
 * @param {object} intake running fake intake
 * @param {object} staticReport static diagnosis report
 * @returns {object} environment overrides
 */
function getTestEnv (options, intake, staticReport) {
  return {
    DD_API_KEY: 'debug',
    DD_SERVICE: options.service,
    DD_CIVISIBILITY_AGENTLESS_ENABLED: '1',
    DD_CIVISIBILITY_AGENTLESS_URL: intake.url,
    DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED: 'true',
    DD_CIVISIBILITY_ENABLED: 'true',
    DD_CIVISIBILITY_FLAKY_RETRY_ENABLED: 'true',
    DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE: 'false',
    DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
    DD_TEST_MANAGEMENT_ENABLED: 'true',
    NODE_OPTIONS: getNodeOptions(staticReport, options.testCommand),
  }
}

/**
 * Gets the NODE_OPTIONS preload for the selected framework.
 *
 * @param {object} staticReport static diagnosis report
 * @param {string} testCommand selected test command
 * @returns {string} NODE_OPTIONS value
 */
function getNodeOptions (staticReport, testCommand) {
  const existing = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ''
  const usesPnp = hasPnpConfig(existing)
  const pnpPreload = getPnpPreload(existing)
  const ciInitPreload = usesPnp ? `-r ${path.resolve(__dirname, 'init.js')}` : '-r dd-trace/ci/init'

  if (isVitestRun(staticReport, testCommand)) {
    const registerImport = usesPnp
      ? `--import ${path.resolve(__dirname, '..', 'register.js')}`
      : '--import dd-trace/register.js'

    return `${existing}${pnpPreload}${registerImport} ${ciInitPreload}`
  }

  return `${existing}${pnpPreload}${ciInitPreload}`
}

/**
 * Checks whether the repository uses Yarn PnP.
 *
 * @param {string} existing existing NODE_OPTIONS value with trailing space when present
 * @returns {boolean} whether Yarn PnP appears to be active
 */
function hasPnpConfig (existing) {
  return fs.existsSync(path.resolve('.pnp.cjs')) ||
    existing.includes('.pnp.cjs') ||
    existing.includes('.pnp.loader.mjs')
}

/**
 * Gets the Yarn PnP preload when the repository uses .pnp.cjs.
 *
 * @param {string} existing existing NODE_OPTIONS value with trailing space when present
 * @returns {string} NODE_OPTIONS fragment
 */
function getPnpPreload (existing) {
  const pnpPath = path.resolve('.pnp.cjs')

  if (!fs.existsSync(pnpPath)) return ''
  if (existing.includes('.pnp.cjs')) return ''

  return `-r ${pnpPath} `
}

/**
 * Checks whether the selected command appears to be a Vitest run.
 *
 * @param {object} staticReport static diagnosis report
 * @param {string} testCommand selected test command
 * @returns {boolean} true when Vitest-specific registration should be used
 */
function isVitestRun (staticReport, testCommand) {
  const frameworks = Array.isArray(staticReport.supportedFrameworks) ? staticReport.supportedFrameworks : []
  const commandText = `${testCommand || ''}\n${getNpmScript(testCommand)}`

  if (/\bvitest\b/i.test(commandText)) return true

  return frameworks.length === 1 && frameworks[0].id === 'vitest'
}

/**
 * Gets the npm script body for the selected command, when it is a simple npm script command.
 *
 * @param {string} testCommand selected test command
 * @returns {string} npm script body
 */
function getNpmScript (testCommand) {
  const scriptName = getNpmScriptName(testCommand || '')
  if (!scriptName) return ''

  try {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'))
    return packageJson.scripts?.[scriptName] || ''
  } catch {
    return ''
  }
}

/**
 * Gets the npm script name from a simple npm command.
 *
 * @param {string} testCommand selected test command
 * @returns {string|undefined} npm script name
 */
function getNpmScriptName (testCommand) {
  const npmRunMatch = testCommand.match(/\bnpm\s+run\s+([^\s]+)/)
  if (npmRunMatch) return npmRunMatch[1]

  if (/\bnpm\s+test\b/.test(testCommand)) return 'test'
}

/**
 * Writes env vars to a file.
 *
 * @param {string} file env file path
 * @param {object} env env vars
 */
function writeEnvFile (file, env) {
  const lines = []

  for (const [key, value] of Object.entries(env)) {
    lines.push(`${key}=${value}`)
  }

  fs.writeFileSync(file, `${lines.join('\n')}\n`)
}

/**
 * Gets the test command exit code.
 *
 * @param {object} result spawnSync result
 * @returns {number|string} exit code
 */
function getSpawnExitCode (result) {
  if (typeof result.status === 'number') return result.status
  if (result.error) return result.error.code || 1

  return 1
}

/**
 * Extracts a one-line test result from runner output.
 *
 * @param {string} output test output
 * @returns {string} test result
 */
function getTestResult (output) {
  const lines = output.split(/\r?\n/)
    .map(line => stripAnsi(line).trim())
    .filter(Boolean)
  const jestResult = getJestTestResult(lines)

  if (jestResult) return jestResult

  return lines.reverse().find(line => /\b\d+\s+(passing|failing|failed|passed|pending|skipped)\b/i.test(line) ||
    /\b\d+\s+tests?\s+(passed|failed|skipped)\b/i.test(line)) || 'unknown'
}

/**
 * Strips terminal formatting from test output lines.
 *
 * @param {string} value terminal output line
 * @returns {string} line without ANSI escape sequences
 */
function stripAnsi (value) {
  return value.replaceAll(ANSI_ESCAPE_RE, '')
}

/**
 * Extracts a Jest summary from cleaned test output lines.
 *
 * @param {string[]} lines cleaned output lines
 * @returns {string|undefined} short Jest result summary
 */
function getJestTestResult (lines) {
  const testsLine = lines.find(line => /^Tests:\s+/i.test(line))
  if (!testsLine) return

  const testParts = getJestCountParts(testsLine, 'test')
  if (testParts.length === 0) return

  const suitesLine = lines.find(line => /^Test Suites:\s+/i.test(line))
  const suiteParts = suitesLine ? getJestCountParts(suitesLine, 'suite') : []
  if (suiteParts.length === 0) return testParts.join(', ')

  return `${testParts.join(', ')} (${suiteParts.join(', ')})`
}

/**
 * Extracts status counts from a Jest summary line.
 *
 * @param {string} line cleaned Jest summary line
 * @param {string} noun singular noun for the summarized item
 * @returns {string[]} formatted count parts
 */
function getJestCountParts (line, noun) {
  const parts = []
  const statuses = ['failed', 'passed', 'skipped', 'pending', 'todo']

  for (const status of statuses) {
    const match = line.match(new RegExp(String.raw`\b(\d+)\s+${status}\b`, 'i'))
    if (!match) continue

    parts.push(`${match[1]} ${pluralize(Number(match[1]), noun)} ${status}`)
  }

  return parts
}

/**
 * Pluralizes a short noun for a count.
 *
 * @param {number} count item count
 * @param {string} noun singular noun
 * @returns {string} singular or plural noun
 */
function pluralize (count, noun) {
  return count === 1 ? noun : `${noun}s`
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2))

  if (options.help) {
    console.log(getHelpText())
  } else if (options.unknown) {
    console.error(`Unknown argument: ${options.unknown}`)
    console.error(getHelpText())
    process.exitCode = 1
  } else if (options.feedbackMode) {
    runFeedbackMode(options, (error, report) => {
      if (error) {
        console.error(error.message)
        process.exitCode = 1
        return
      }

      console.log(report)
    })
  } else {
    runDebug(options, (error, report) => {
      if (error) {
        console.error(error.message)
        process.exitCode = 1
        return
      }

      console.log(report)
    })
  }
}

module.exports = {
  assertAdvancedPlanMatchesSelectedFiles,
  getNodeOptions,
  getTestResult,
  isVitestRun,
  parseArgs,
  runDebug,
  runFeedbackMode,
}
