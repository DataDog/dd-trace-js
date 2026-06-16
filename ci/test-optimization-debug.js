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
  prepareAtrBaselineCandidate,
  prepareAdvancedChecks,
  restoreAdvancedChecks,
} = require('./test-optimization-prepare-advanced')
const {
  buildTestManagementResponse,
  createTestManagementCandidate,
  inferTestManagementPlan,
  restoreTestManagementChecks,
} = require('./test-optimization-prepare-test-management')
const {
  getEfdExecutionDiagnostics,
  renderFinalReport,
  renderSummaryReport,
} = require('./test-optimization-render-report')
const {
  getBasicReportingFailureCause,
  getCombinedValidationAppUrlFromReports,
  getStaticValidationAppUrl,
} = require('./test-optimization-validation-link')
const {
  selectTestCommand,
} = require('./test-optimization-select-command')
const {
  normalizeKnownTests,
  normalizeTestManagementTests,
  startIntake,
  stopIntake,
} = require('./test-optimization-intake')

const ARTIFACTS = {
  agentJsonReport: 'dd-test-optimization-agent-report.json',
  agentReport: 'dd-test-optimization-agent-report.txt',
  artifactManifest: 'dd-test-optimization-artifacts.json',
  diagnosis: 'dd-test-optimization-diagnosis.json',
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
  atrBaselineCommand: 'dd-test-optimization-atr-baseline-command.txt',
  atrBaselinePreflight: 'dd-test-optimization-atr-baseline-preflight.txt',
  basicDir: 'dd-test-optimization-basic',
  efdDir: 'dd-test-optimization-efd',
  efdCommand: 'dd-test-optimization-efd-command.txt',
  knownTests: 'dd-test-optimization-known-tests.json',
  rootStage: 'dd-test-optimization-root-stage.txt',
  selectedTestFiles: 'dd-test-optimization-selected-test-files.txt',
}
const DEFAULT_READY_TIMEOUT_MS = 5000
const READY_RETRY_INTERVAL_MS = 50
const TEST_MANAGEMENT_MODES = ['disabled', 'quarantined', 'attempt-to-fix']

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
    } else if (arg === '--full') {
      options.full = true
    } else if (arg === '--tm-all') {
      options.tmAll = true
    } else if (arg === '--framework') {
      options.framework = args[++i]
    } else if (arg.startsWith('--framework=')) {
      options.framework = arg.slice('--framework='.length)
    } else if (arg === '--package-root') {
      options.packageRoot = args[++i]
    } else if (arg.startsWith('--package-root=')) {
      options.packageRoot = arg.slice('--package-root='.length)
    } else if (arg === '--preflight') {
      options.preflight = true
    } else if (arg === '--force-run-in-band') {
      options.forceRunInBand = true
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
    '  --full                    Select a command and run basic, EFD/ATR, Test Management, validation, and extraction.',
    '  --tm-all                  Run all three Test Management modes from existing selected-command artifacts.',
    '  --framework <name>        Framework focus for --full selection, for example jest, mocha, or vitest.',
    '  --package-root <dir>      Select tests from a nested package directory for --full.',
    '  --preflight               In --full selection, try candidate commands and choose the first that exits 0.',
    '  --force-run-in-band       Force generated Jest-style multi-file commands to include --runInBand.',
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
          fs.writeFileSync(artifacts.diagnosis, `${JSON.stringify(getDiagnosisArtifact({
            analysis,
            staticReport,
            testCommand,
          }), null, 2)}\n`)
          writeArtifactManifest(artifacts)
          callback(undefined, finalReport)
        })
      })
    })
  })
}

/**
 * Gets a machine-readable diagnosis artifact for agents.
 *
 * @param {object} input diagnosis input
 * @param {object} input.analysis intake analysis
 * @param {object} input.staticReport static diagnosis report
 * @param {string} input.testCommand selected test command
 * @returns {object} diagnosis artifact
 */
function getDiagnosisArtifact (input) {
  const stage = input.analysis.primaryStage
  const advancedSkipReason = stage === 'Reporting complete'
    ? undefined
    : `Advanced checks skipped because the root wrapper stage was "${stage}", not "Reporting complete".`

  return {
    advancedSkipReason,
    basicReportingComplete: stage === 'Reporting complete',
    likelyFailureCause: stage === 'Reporting complete'
      ? undefined
      : getBasicReportingFailureCause({
        staticReport: input.staticReport,
        testCommand: input.testCommand,
      }, input.analysis),
    primaryStage: stage,
  }
}

/**
 * Gets a machine-readable artifact manifest for the wrapper run.
 *
 * @param {object} artifacts resolved artifact paths
 * @returns {object} artifact manifest
 */
function getArtifactManifest (artifacts) {
  const entries = {}

  for (const [name, file] of Object.entries(artifacts)) {
    entries[name] = {
      exists: name === 'artifactManifest' || fs.existsSync(file),
      path: path.resolve(file),
    }
  }

  return {
    artifacts: entries,
    generatedAt: new Date().toISOString(),
  }
}

/**
 * Writes the artifact manifest after all other wrapper artifacts exist.
 *
 * @param {object} artifacts resolved artifact paths
 */
function writeArtifactManifest (artifacts) {
  fs.writeFileSync(artifacts.artifactManifest, `${JSON.stringify(getArtifactManifest(artifacts), null, 2)}\n`)
}

/**
 * Runs the full customer validation flow.
 *
 * @param {object} options full validation options
 * @param {Function} callback called with (error, report)
 */
function runFullValidation (options, callback) {
  let selection

  try {
    restoreGeneratedSources()
    selection = getFullValidationSelection(options)
    writeFullSelectionArtifacts(selection)
  } catch (error) {
    finalizeFullValidationSelectionFailure(error, options, callback)
    return
  }

  runDebug(getFullDebugOptions(options, {
    testCommand: selection.command,
  }), (rootError) => {
    if (rootError) {
      callback(rootError)
      return
    }

    const rootStage = getRootStage()
    fs.writeFileSync(FEEDBACK_ARTIFACTS.rootStage, `${rootStage}\n`)
    console.log(`Basic reporting: ${rootStage === 'Reporting complete' ? 'passed' : rootStage}`)

    if (rootStage !== 'Reporting complete') {
      finalizeFullValidation(callback)
      return
    }

    runAdvancedFullValidation(options, (advancedError) => {
      if (advancedError) {
        callback(advancedError)
        return
      }

      runTestManagementAllModes(options, (tmError) => {
        if (tmError) {
          callback(tmError)
          return
        }

        finalizeFullValidation(callback)
      })
    })
  })
}

/**
 * Writes static-only artifacts when full validation stops before a live run.
 *
 * @param {Error} error selection failure
 * @param {object} options full validation options
 * @param {Function} callback called with (error, report)
 */
function finalizeFullValidationSelectionFailure (error, options, callback) {
  let staticReport

  try {
    staticReport = runDiagnosis()
    fs.writeFileSync(ARTIFACTS.static, `${JSON.stringify(staticReport, null, 2)}\n`)
    fs.writeFileSync('dd-test-optimization-framework.txt', `${options.framework || 'not selected'}\n`)
    fs.writeFileSync(ARTIFACTS.testResult, `validation skipped: ${error.message}\n`)
    fs.writeFileSync(ARTIFACTS.diagnosis, `${JSON.stringify({
      advancedSkipReason: 'Advanced checks skipped because live validation was not started.',
      basicReportingComplete: false,
      likelyFailureCause: error.message,
      primaryStage: 'Not run',
    }, null, 2)}\n`)
    writeArtifactManifest(ARTIFACTS)
  } catch (artifactError) {
    callback(artifactError)
    return
  }

  finalizeStaticOnlyValidation(callback)
}

/**
 * Writes the static-only validation URL and extractor output.
 *
 * @param {Function} callback called with (error, report)
 */
function finalizeStaticOnlyValidation (callback) {
  const validationLine = `Datadog validation: ${getStaticValidationAppUrl({
    diagnosis: ARTIFACTS.diagnosis,
    frameworkFile: 'dd-test-optimization-framework.txt',
    staticReport: ARTIFACTS.static,
    testResultFile: ARTIFACTS.testResult,
  })}`

  fs.writeFileSync('dd-test-optimization-validation-url.txt', `${validationLine}\n`)

  const extractor = spawnSync(process.execPath, [path.join(__dirname, 'test-optimization-extract-report.js')], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  const output = extractor.stdout || extractor.stderr || ''

  fs.writeFileSync('dd-test-optimization-step9-extractor-output.txt', output)
  if (extractor.status !== 0) {
    callback(new Error(`Step 9 extractor failed: ${extractor.stderr || extractor.stdout}`))
    return
  }

  callback(undefined, output.trimEnd())
}

/**
 * Restores temporary source edits before a full run starts.
 */
function restoreGeneratedSources () {
  try {
    restoreAdvancedChecks()
  } catch {}

  try {
    restoreTestManagementChecks()
  } catch {}
}

/**
 * Gets the selected command and files for full validation.
 *
 * @param {object} options full validation options
 * @returns {{command: string, file: string, files: string[], framework: string}} selection
 */
function getFullValidationSelection (options) {
  const command = readTextValue(options.testCommand, options.testCommandFile, 'test command')

  if (command) {
    const files = readSelectedTestFilesIfPresent(options.selectedTestFilesFile)
    if (files.length === 0) {
      throw new Error('Full validation with an explicit command requires --selected-test-files-file.')
    }

    return {
      command,
      file: files[0],
      files,
      framework: options.framework || 'manual',
    }
  }

  const selection = selectTestCommand({
    framework: options.framework,
    packageRoot: options.packageRoot,
    preflight: options.preflight,
  })

  return {
    command: selection.command,
    file: selection.file,
    files: [selection.file],
    framework: selection.framework,
  }
}

/**
 * Writes selected full-validation state files.
 *
 * @param {{command: string, files: string[], framework: string}} selection selection
 */
function writeFullSelectionArtifacts (selection) {
  fs.writeFileSync(ARTIFACTS.testCommand, `${selection.command}\n`)
  fs.writeFileSync(FEEDBACK_ARTIFACTS.selectedTestFiles, `${selection.files.join('\n')}\n`)
  fs.writeFileSync('dd-test-optimization-framework.txt', `${selection.framework}\n`)
}

/**
 * Reads selected test files when a file was provided.
 *
 * @param {string|undefined} file selected test files file
 * @returns {string[]} selected test files
 */
function readSelectedTestFilesIfPresent (file) {
  if (!file) return []

  return readSelectedTestFiles(file)
}

/**
 * Runs full validation EFD and Auto Test Retries.
 *
 * @param {object} options full validation options
 * @param {Function} callback called when done
 */
function runAdvancedFullValidation (options, callback) {
  const selectedTestFiles = readSelectedTestFiles(FEEDBACK_ARTIFACTS.selectedTestFiles)

  try {
    prepareAtrBaselineCandidate({
      auto: true,
      baselineCandidate: true,
      forceRunInBand: options.forceRunInBand,
    })
    preflightAtrBaselineCandidate(options)
  } catch (error) {
    restoreAdvancedChecksAfterFailure(error, callback)
    return
  }

  runDebug(getFullDebugOptions(options, {
    outDir: FEEDBACK_ARTIFACTS.basicDir,
    testCommand: undefined,
    testCommandFile: FEEDBACK_ARTIFACTS.atrBaselineCommand,
  }), (basicError) => {
    if (basicError) {
      callback(basicError)
      return
    }

    try {
      writeKnownTestsFromBaseline()
      dryRunAdvancedChecks(selectedTestFiles, options)
      prepareAdvancedChecks({ auto: true, forceRunInBand: options.forceRunInBand })
    } catch (error) {
      restoreAdvancedChecksAfterFailure(error, callback)
      return
    }

    runDebug(getFullDebugOptions(options, {
      flakyTestSnippetFile: 'dd-test-optimization-atr-flaky-test-snippet.txt',
      knownTests: normalizeKnownTests(readJsonFile(FEEDBACK_ARTIFACTS.knownTests)),
      newTestSnippetFile: 'dd-test-optimization-efd-new-test-snippet.txt',
      outDir: FEEDBACK_ARTIFACTS.efdDir,
      settingsMode: 'debug-all',
      testCommand: undefined,
      testCommandFile: FEEDBACK_ARTIFACTS.efdCommand,
    }), (advancedError) => {
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

      try {
        assertAdvancedFeedbackEvidence()
      } catch (error) {
        callback(error)
        return
      }

      callback()
    })
  })
}

/**
 * Runs the generated Auto Test Retries baseline candidate without the fake intake.
 *
 * @param {object} options full validation options
 */
function preflightAtrBaselineCandidate (options) {
  if (!options.preflight) return

  const command = fs.readFileSync(FEEDBACK_ARTIFACTS.atrBaselineCommand, 'utf8').trim()
  const result = spawnSync(command, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 1024 * 1024 * 20,
    shell: true,
  })
  const output = `${result.stdout || ''}${result.stderr || ''}`
  const exitCode = getSpawnExitCode(result)

  fs.writeFileSync(FEEDBACK_ARTIFACTS.atrBaselinePreflight, output)
  if (exitCode !== 0) {
    throw new Error(
      `Generated Auto Test Retries baseline preflight failed with exit code ${exitCode}. ` +
      `See ${FEEDBACK_ARTIFACTS.atrBaselinePreflight}.`
    )
  }

  console.log('Generated Auto Test Retries baseline preflight: passed')
}

/**
 * Gets wrapper options for one full-validation wrapper run.
 *
 * @param {object} options full validation options
 * @param {object} overrides wrapper option overrides
 * @returns {object} wrapper options
 */
function getFullDebugOptions (options, overrides = {}) {
  return {
    ...options,
    clean: true,
    feedbackMode: false,
    full: false,
    open: false,
    tmAll: false,
    ...overrides,
  }
}

/**
 * Runs all Test Management subchecks.
 *
 * @param {object} options full validation options
 * @param {Function} callback called when done
 */
function runTestManagementAllModes (options, callback) {
  runTestManagementModeAtIndex(options, 0, callback)
}

/**
 * Runs one Test Management mode by index.
 *
 * @param {object} options full validation options
 * @param {number} index mode index
 * @param {Function} callback called when done
 */
function runTestManagementModeAtIndex (options, index, callback) {
  if (index >= TEST_MANAGEMENT_MODES.length) {
    callback()
    return
  }

  runTestManagementMode(options, TEST_MANAGEMENT_MODES[index], (error) => {
    if (error) {
      callback(error)
      return
    }

    runTestManagementModeAtIndex(options, index + 1, callback)
  })
}

/**
 * Runs one Test Management mode.
 *
 * @param {object} options full validation options
 * @param {string} mode Test Management mode
 * @param {Function} callback called when done
 */
function runTestManagementMode (options, mode, callback) {
  let plan

  try {
    plan = inferTestManagementPlan({
      auto: true,
      forceRunInBand: options.forceRunInBand,
      mode,
      selectedTestFilesFile: FEEDBACK_ARTIFACTS.selectedTestFiles,
    })
    createTestManagementCandidate(plan)
  } catch (error) {
    restoreTestManagementModeAfterFailure(error, callback)
    return
  }

  const baselineDir = `dd-test-optimization-tm-${mode}-baseline`
  const resultDir = `dd-test-optimization-tm-${mode}`
  const baselineCommand = prefixEnvForCommand('DD_TEST_OPTIMIZATION_TM_BASELINE=1', plan.testCommand)

  runDebug(getFullDebugOptions(options, {
    outDir: baselineDir,
    settingsMode: 'basic-reporting',
    testCommand: baselineCommand,
  }), (baselineError) => {
    if (baselineError) {
      restoreTestManagementModeAfterFailure(baselineError, callback)
      return
    }

    try {
      buildTestManagementResponse({
        baselineIntake: path.join(baselineDir, ARTIFACTS.intake),
        identityOut: path.join(resultDir, 'test-management-identity.json'),
        mode,
        out: path.join(resultDir, 'test-management-tests.json'),
      })
    } catch (error) {
      restoreTestManagementModeAfterFailure(error, callback)
      return
    }

    runDebug(getFullDebugOptions(options, {
      outDir: resultDir,
      settingsMode: plan.settingsMode,
      testCommand: plan.testCommand,
      testManagementTests: normalizeTestManagementTests(
        readJsonFile(path.join(resultDir, 'test-management-tests.json'))
      ),
    }), (managedError) => {
      let restoreError

      try {
        restoreTestManagementChecks()
      } catch (error) {
        restoreError = error
      }

      if (managedError) {
        callback(managedError)
        return
      }

      if (restoreError) {
        callback(restoreError)
        return
      }

      try {
        assertTestManagementModeEvidence(mode, resultDir)
      } catch (error) {
        callback(error)
        return
      }

      callback()
    })
  })
}

/**
 * Prefixes an environment assignment to a command, preserving simple `cd <dir> && <command>` wrappers.
 *
 * @param {string} envAssignment environment assignment
 * @param {string} command command to run
 * @returns {string} command with the environment assignment scoped to the runner
 */
function prefixEnvForCommand (envAssignment, command) {
  const cdMatch = command.match(/^(cd\s+(?:"[^"]+"|'[^']+'|[^&\s]+)\s+&&\s+)([\s\S]+)$/)
  if (cdMatch) return `${cdMatch[1]}${envAssignment} ${cdMatch[2]}`

  return `${envAssignment} ${command}`
}

/**
 * Restores Test Management generated files after a failure.
 *
 * @param {Error} originalError original failure
 * @param {Function} callback called with the original error
 */
function restoreTestManagementModeAfterFailure (originalError, callback) {
  try {
    restoreTestManagementChecks()
  } catch (restoreError) {
    console.error(`Test Management restore failed after error: ${restoreError.message}`)
  }

  callback(originalError)
}

/**
 * Validates one Test Management mode result.
 *
 * @param {string} mode Test Management mode
 * @param {string} resultDir Test Management result directory
 */
function assertTestManagementModeEvidence (mode, resultDir) {
  const report = readJsonFile(path.join(resultDir, ARTIFACTS.agentJsonReport))
  const exitCode = readOptionalTextFile(path.join(resultDir, ARTIFACTS.testExitCode))
  const tm = report.summary.tm
  const expected = mode === 'attempt-to-fix' ? 'attemptToFix' : mode
  const subcheck = tm[expected]

  assertFeedbackEvidence(tm.settingsEnabled, 'Test Management settings were not enabled.')
  assertFeedbackEvidence(tm.propertiesEndpointCalled, 'Test Management properties endpoint was not called.')
  assertFeedbackEvidence(tm.returnedProperties > 0, 'Test Management properties response was empty.')
  assertFeedbackEvidence(
    tm.unmatchedPropertyIdentities.length === 0,
    `Test Management properties did not match emitted identities: ${tm.unmatchedPropertyIdentities.join(', ')}`
  )
  assertFeedbackEvidence(
    subcheck && subcheck.status === 'passed',
    `Test Management ${mode} subcheck failed: ${subcheck?.reason || 'missing subcheck'}`
  )

  if (mode === 'disabled' || mode === 'quarantined') {
    assertFeedbackEvidence(exitCode === '0', `Expected ${mode} command exit code 0, got ${exitCode}.`)
  } else {
    assertFeedbackEvidence(exitCode !== '0', 'Expected attempt-to-fix command exit code to be non-zero.')
    assertFeedbackEvidence(
      subcheck.badRetryReasons.length === 0,
      `Attempt-to-fix used unexpected retry reasons: ${subcheck.badRetryReasons.join(', ')}`
    )
  }

  console.log(`Test Management ${mode}: passed`)
}

/**
 * Writes combined validation and extractor artifacts for a full run.
 *
 * @param {Function} callback called with (error, report)
 */
function finalizeFullValidation (callback) {
  const reports = getFullValidationReports()
  let validationLine

  try {
    validationLine = `Datadog validation: ${
      getCombinedValidationAppUrlFromReports(reports, { strictTestManagement: hasAllTestManagementReports() })
    }`
    fs.writeFileSync('dd-test-optimization-validation-url.txt', `${validationLine}\n`)
  } catch (error) {
    callback(error)
    return
  }

  const extractor = spawnSync(process.execPath, [path.join(__dirname, 'test-optimization-extract-report.js')], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  const output = extractor.stdout || extractor.stderr || ''

  fs.writeFileSync('dd-test-optimization-step9-extractor-output.txt', output)
  if (extractor.status !== 0) {
    callback(new Error(`Step 9 extractor failed: ${extractor.stderr || extractor.stdout}`))
    return
  }

  callback(undefined, output.trimEnd())
}

/**
 * Gets final reports that exist for full validation.
 *
 * @returns {string[]} final report paths
 */
function getFullValidationReports () {
  return [
    ARTIFACTS.finalReport,
    path.join(FEEDBACK_ARTIFACTS.efdDir, ARTIFACTS.finalReport),
    ...TEST_MANAGEMENT_MODES.map(mode => path.join(`dd-test-optimization-tm-${mode}`, ARTIFACTS.finalReport)),
  ].filter(file => fs.existsSync(file))
}

/**
 * Checks whether all Test Management final reports exist.
 *
 * @returns {boolean} whether every Test Management subcheck report exists
 */
function hasAllTestManagementReports () {
  return TEST_MANAGEMENT_MODES.every(mode =>
    fs.existsSync(path.join(`dd-test-optimization-tm-${mode}`, ARTIFACTS.finalReport))
  )
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

  runDebug(getFeedbackDebugOptions(options), (rootError) => {
    if (rootError) {
      callback(rootError)
      return
    }

    const rootStage = getRootStage()

    fs.writeFileSync(FEEDBACK_ARTIFACTS.rootStage, `${rootStage}\n`)
    console.log(`Root wrapper stage: ${rootStage}`)

    if (rootStage !== 'Reporting complete') {
      callback(undefined, getFeedbackModeSummary(rootStage, false))
      return
    }

    runDebug(getFeedbackDebugOptions(options, { outDir: FEEDBACK_ARTIFACTS.basicDir }), (basicError) => {
      if (basicError) {
        callback(basicError)
        return
      }

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
      }), (advancedError) => {
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
 * @param {object} options full validation options
 */
function dryRunAdvancedChecks (selectedTestFiles, options) {
  const plan = getPreparePlan({ auto: true, forceRunInBand: options.forceRunInBand })
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
  assertAdvancedPlanMatchesSelectedFiles(prepareOptions, selectedTestFiles, plan.generatedAtrCandidate)
  console.log('Advanced dry-run guardrails: passed')
}

/**
 * Validates inferred advanced-check targets against selected test files.
 *
 * @param {object} prepareOptions inferred advanced-check options
 * @param {string[]} selectedTestFiles selected test files
 * @param {boolean} generatedAtrCandidate whether the ATR target is generated
 */
function assertAdvancedPlanMatchesSelectedFiles (prepareOptions, selectedTestFiles, generatedAtrCandidate) {
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

  if (generatedAtrCandidate && !selectedDirs.has(path.dirname(flakyFile))) {
    throw new Error(`Generated Auto Test Retries file is not under a selected test directory: ${flakyFile}`)
  }

  if (!generatedAtrCandidate && !selectedFiles.includes(flakyFile)) {
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
  } else if (options.full) {
    runFullValidation(options, (error, report) => {
      if (error) {
        console.error(error.message)
        process.exitCode = 1
        return
      }

      console.log(report)
    })
  } else if (options.tmAll) {
    runTestManagementAllModes(options, (error) => {
      if (error) {
        console.error(error.message)
        process.exitCode = 1
        return
      }

      finalizeFullValidation((finalizeError, report) => {
        if (finalizeError) {
          console.error(finalizeError.message)
          process.exitCode = 1
          return
        }

        console.log(report)
      })
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
  prefixEnvForCommand,
  runDebug,
  runFeedbackMode,
  runFullValidation,
  runTestManagementAllModes,
}
