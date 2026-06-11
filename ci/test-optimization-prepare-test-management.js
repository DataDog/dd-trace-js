'use strict'

/* eslint-disable no-console */

const fs = require('node:fs')
const path = require('node:path')

const {
  buildTestManagementTestsFromArtifact,
} = require('./test-optimization-intake-analysis')
const {
  addTestFileToCommand,
  getTestFileSuffix,
} = require('./test-optimization-prepare-advanced')

const DEFAULT_ARTIFACT_DIR = 'dd-test-optimization-test-management'
const DEFAULT_IDENTITY_FILE = path.join(DEFAULT_ARTIFACT_DIR, 'identity.json')
const DEFAULT_KNOWN_TESTS_FILE = 'dd-test-optimization-known-tests.json'
const DEFAULT_MARKER_FILE = path.join(DEFAULT_ARTIFACT_DIR, 'attempt-to-fix-marker')
const DEFAULT_RESPONSE_FILE = path.join(DEFAULT_ARTIFACT_DIR, 'test-management-tests.json')
const DEFAULT_SELECTED_TEST_FILES_FILE = 'dd-test-optimization-selected-test-files.txt'
const DEFAULT_SNIPPET_FILE = path.join(DEFAULT_ARTIFACT_DIR, 'candidate-snippet.txt')
const DEFAULT_TEST_COMMAND_FILE = 'dd-test-optimization-test-command.txt'
const GENERATED_FILES_STATE = path.join(DEFAULT_ARTIFACT_DIR, 'generated-files.txt')
const MARKER_FILES_STATE = path.join(DEFAULT_ARTIFACT_DIR, 'marker-files.txt')
const MODES = new Set(['disabled', 'quarantined', 'attempt-to-fix'])
const SETTINGS_MODES = {
  'attempt-to-fix': 'tm-attempt-to-fix',
  disabled: 'tm-disabled',
  quarantined: 'tm-quarantined',
}
const STATE_FILES = {
  framework: 'dd-test-optimization-tm-framework.txt',
  mode: 'dd-test-optimization-tm-mode.txt',
  settingsMode: 'dd-test-optimization-tm-settings-mode.txt',
  testCommand: 'dd-test-optimization-tm-test-command.txt',
  testFile: 'dd-test-optimization-tm-test-file.txt',
}
const TEST_NAMES = {
  disabled: 'dd trace test management disabled candidate',
  quarantined: 'dd trace test management quarantined candidate',
  'attempt-to-fix': 'dd trace test management attempt-to-fix candidate',
}

/**
 * Parses CLI arguments.
 *
 * @param {string[]} args command-line arguments
 * @returns {object} parsed options
 */
function parseArgs (args) {
  const options = {
    framework: 'mocha',
    identityOut: DEFAULT_IDENTITY_FILE,
    markerFile: DEFAULT_MARKER_FILE,
    out: DEFAULT_RESPONSE_FILE,
    snippetOut: DEFAULT_SNIPPET_FILE,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--create') {
      options.create = true
    } else if (arg === '--response') {
      options.response = true
    } else if (arg === '--restore') {
      options.restore = true
    } else if (arg === '--auto') {
      options.auto = true
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--mode') {
      options.mode = args[++i]
    } else if (arg.startsWith('--mode=')) {
      options.mode = arg.slice('--mode='.length)
    } else if (arg === '--framework') {
      options.framework = args[++i]
      options.frameworkExplicit = true
    } else if (arg.startsWith('--framework=')) {
      options.framework = arg.slice('--framework='.length)
      options.frameworkExplicit = true
    } else if (arg === '--test-file') {
      options.testFile = args[++i]
    } else if (arg.startsWith('--test-file=')) {
      options.testFile = arg.slice('--test-file='.length)
    } else if (arg === '--test-name') {
      options.testName = args[++i]
    } else if (arg.startsWith('--test-name=')) {
      options.testName = arg.slice('--test-name='.length)
    } else if (arg === '--test-command') {
      options.testCommand = args[++i]
    } else if (arg.startsWith('--test-command=')) {
      options.testCommand = arg.slice('--test-command='.length)
    } else if (arg === '--test-command-file') {
      options.testCommandFile = args[++i]
    } else if (arg.startsWith('--test-command-file=')) {
      options.testCommandFile = arg.slice('--test-command-file='.length)
    } else if (arg === '--known-tests-file') {
      options.knownTestsFile = args[++i]
    } else if (arg.startsWith('--known-tests-file=')) {
      options.knownTestsFile = arg.slice('--known-tests-file='.length)
    } else if (arg === '--selected-test-files-file') {
      options.selectedTestFilesFile = args[++i]
    } else if (arg.startsWith('--selected-test-files-file=')) {
      options.selectedTestFilesFile = arg.slice('--selected-test-files-file='.length)
    } else if (arg === '--settings-mode') {
      options.settingsMode = args[++i]
    } else if (arg.startsWith('--settings-mode=')) {
      options.settingsMode = arg.slice('--settings-mode='.length)
    } else if (arg === '--baseline-intake') {
      options.baselineIntake = args[++i]
    } else if (arg.startsWith('--baseline-intake=')) {
      options.baselineIntake = arg.slice('--baseline-intake='.length)
    } else if (arg === '--out') {
      options.out = args[++i]
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length)
    } else if (arg === '--identity-out') {
      options.identityOut = args[++i]
    } else if (arg.startsWith('--identity-out=')) {
      options.identityOut = arg.slice('--identity-out='.length)
    } else if (arg === '--snippet-out') {
      options.snippetOut = args[++i]
    } else if (arg.startsWith('--snippet-out=')) {
      options.snippetOut = arg.slice('--snippet-out='.length)
    } else if (arg === '--marker-file') {
      options.markerFile = args[++i]
    } else if (arg.startsWith('--marker-file=')) {
      options.markerFile = arg.slice('--marker-file='.length)
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
    'Usage:',
    '  dd-trace TM helper --auto --mode <disabled|quarantined|attempt-to-fix>',
    '  dd-trace TM helper --create --mode <disabled|quarantined|attempt-to-fix> ' +
      '--framework <mocha|jest|vitest> --test-file <file>',
    '  dd-trace TM helper --response --mode <disabled|quarantined|attempt-to-fix> ' +
      '--baseline-intake <intake.json>',
    '  dd-trace TM helper --restore',
    '',
    'Creates temporary Test Management candidate tests and builds calibrated modules JSON from a baseline run.',
    '',
    'Use --auto to infer state files from the selected command and selected test files.',
    'When dd-test-optimization-known-tests.json exists, --auto prefers its framework and suite identity.',
    'Use --dry-run with --auto to print the inferred state without writing files.',
    '',
    'Run generated tests once with DD_TEST_OPTIMIZATION_TM_BASELINE=1 before building the response.',
  ].join('\n')
}

/**
 * Creates a temporary Test Management candidate test file.
 *
 * @param {object} options helper options
 */
function createTestManagementCandidate (options) {
  validateMode(options.mode)
  validateCreateOptions(options)

  const testFile = path.resolve(options.testFile)
  const testName = options.testName || TEST_NAMES[options.mode]
  const framework = options.framework || 'mocha'
  const markerFile = options.markerFile || DEFAULT_MARKER_FILE
  const snippetOut = options.snippetOut || DEFAULT_SNIPPET_FILE
  const source = getTemporaryTestSource(framework, options.mode, testName, markerFile)

  fs.mkdirSync(path.dirname(testFile), { recursive: true })
  fs.writeFileSync(testFile, source)
  fs.mkdirSync(DEFAULT_ARTIFACT_DIR, { recursive: true })
  appendStateFile(GENERATED_FILES_STATE, testFile)
  appendStateFile(MARKER_FILES_STATE, path.resolve(markerFile))
  fs.mkdirSync(path.dirname(path.resolve(snippetOut)), { recursive: true })
  fs.writeFileSync(path.resolve(snippetOut), source)

  console.log(`Test Management mode: ${options.mode}`)
  console.log(`Temporary Test Management test file: ${options.testFile}`)
  console.log(`Temporary Test Management test name: ${testName}`)
  console.log(`Temporary Test Management snippet: ${snippetOut}`)
}

/**
 * Builds a calibrated Test Management response from a baseline intake artifact.
 *
 * @param {object} options helper options
 */
function buildTestManagementResponse (options) {
  validateMode(options.mode)
  if (!options.baselineIntake) throw new Error('Missing --baseline-intake.')

  const artifact = readJsonFile(options.baselineIntake)
  const testName = options.testName || TEST_NAMES[options.mode]
  const properties = getProperties(options.mode)
  const { identity, modules } = buildTestManagementTestsFromArtifact(artifact, properties, { testName })
  const identityOut = options.identityOut || DEFAULT_IDENTITY_FILE
  const markerFile = options.markerFile || DEFAULT_MARKER_FILE
  const out = options.out || DEFAULT_RESPONSE_FILE
  const response = {
    data: {
      attributes: {
        modules,
      },
    },
  }

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  fs.writeFileSync(path.resolve(out), `${JSON.stringify(response, null, 2)}\n`)
  fs.mkdirSync(path.dirname(path.resolve(identityOut)), { recursive: true })
  fs.writeFileSync(path.resolve(identityOut), `${JSON.stringify({
    identity,
    mode: options.mode,
    properties,
  }, null, 2)}\n`)

  if (options.mode === 'attempt-to-fix') {
    fs.rmSync(path.resolve(markerFile), { force: true })
  }

  console.log(`Test Management response: ${out}`)
  console.log(`Test Management calibrated identity: ${formatIdentity(identity)}`)
  console.log(`Test Management properties: ${JSON.stringify(properties)}`)
}

/**
 * Writes inferred state files for one Test Management subcheck.
 *
 * @param {object} options helper options
 */
function writeAutoTestManagementPlan (options) {
  const plan = inferTestManagementPlan(options)

  fs.writeFileSync(getModeCommandFile(plan.mode), `${plan.testCommand}\n`)
  fs.writeFileSync(STATE_FILES.mode, `${plan.mode}\n`)
  fs.writeFileSync(STATE_FILES.settingsMode, `${plan.settingsMode}\n`)
  fs.writeFileSync(STATE_FILES.framework, `${plan.framework}\n`)
  fs.writeFileSync(STATE_FILES.testFile, `${plan.testFile}\n`)
  fs.writeFileSync(STATE_FILES.testCommand, `${plan.testCommand}\n`)

  printAutoTestManagementPlan(plan)
  console.log('Test Management helper state files written.')
}

/**
 * Prints inferred state files for one Test Management subcheck without writing files.
 *
 * @param {object} options helper options
 */
function dryRunAutoTestManagementPlan (options) {
  const plan = inferTestManagementPlan(options)

  printAutoTestManagementPlan(plan)
  console.log('No files written.')
}

/**
 * Infers the state needed by Step 8 from prior runbook artifacts.
 *
 * @param {object} options helper options
 * @returns {object} inferred plan
 */
function inferTestManagementPlan (options) {
  validateMode(options.mode)

  const knownTestsFile = options.knownTestsFile || DEFAULT_KNOWN_TESTS_FILE
  const testCommandFile = options.testCommandFile || DEFAULT_TEST_COMMAND_FILE
  const selectedCommand = fs.readFileSync(path.resolve(testCommandFile), 'utf8').trim()
  const inferred = getTestManagementInference(options, knownTestsFile, selectedCommand)
  const testFile = options.testFile || getTemporaryTestManagementFile(inferred.suite, options.mode)
  const testCommand = options.testCommand || addTestFileToCommand(selectedCommand, inferred.suite, testFile)
  const settingsMode = options.settingsMode || SETTINGS_MODES[options.mode]

  if (fs.existsSync(testFile)) {
    throw new Error(`Temporary Test Management test already exists: ${testFile}`)
  }

  return {
    ...options,
    framework: options.frameworkExplicit ? options.framework : inferred.framework,
    settingsMode,
    testCommand,
    testFile,
  }
}

/**
 * Infers the selected suite and framework for a generated Test Management test.
 *
 * @param {object} options helper options
 * @param {string} knownTestsFile known-tests file path
 * @param {string} selectedCommand selected test command
 * @returns {{framework: string, suite: string, testName: string|undefined}} inferred identity
 */
function getTestManagementInference (options, knownTestsFile, selectedCommand) {
  if (fs.existsSync(path.resolve(knownTestsFile))) {
    return getFirstKnownTest(readJsonFile(knownTestsFile), knownTestsFile)
  }

  const selectedTestFilesFile = options.selectedTestFilesFile || DEFAULT_SELECTED_TEST_FILES_FILE
  const selectedFiles = readStateFile(selectedTestFilesFile)
  const selectedFile = selectedFiles[0]

  if (!selectedFile) {
    throw new Error(
      `Could not infer Test Management helper arguments from ${knownTestsFile} or ${selectedTestFilesFile}.`
    )
  }

  return {
    framework: inferFrameworkFromCommand(selectedCommand, options.framework),
    suite: selectedFile,
  }
}

/**
 * Infers a framework from the selected command when possible.
 *
 * @param {string} selectedCommand selected test command
 * @param {string} fallback fallback framework
 * @returns {string} inferred framework
 */
function inferFrameworkFromCommand (selectedCommand, fallback) {
  if (/\bvitest\b/.test(selectedCommand)) return 'vitest'
  if (/\bjest\b/.test(selectedCommand)) return 'jest'
  if (/\bmocha\b/.test(selectedCommand)) return 'mocha'

  return fallback || 'mocha'
}

/**
 * Removes generated Test Management source and marker files.
 */
function restoreTestManagementChecks () {
  for (const file of readStateFile(GENERATED_FILES_STATE)) {
    fs.rmSync(file, { force: true })
    console.log(`Temporary Test Management test removed: ${file}`)
  }

  for (const file of readStateFile(MARKER_FILES_STATE)) {
    fs.rmSync(file, { force: true })
  }

  fs.rmSync(path.resolve(DEFAULT_MARKER_FILE), { force: true })
  fs.rmSync(GENERATED_FILES_STATE, { force: true })
  fs.rmSync(MARKER_FILES_STATE, { force: true })
  for (const file of Object.values(STATE_FILES)) {
    fs.rmSync(file, { force: true })
  }
  for (const mode of MODES) {
    fs.rmSync(getModeCommandFile(mode), { force: true })
  }
  removeEmptyDiagnosticDirectory()
}

/**
 * Validates a Test Management mode.
 *
 * @param {string|undefined} mode Test Management mode
 */
function validateMode (mode) {
  if (MODES.has(mode)) return

  throw new Error('Missing or unsupported --mode. Use disabled, quarantined, or attempt-to-fix.')
}

/**
 * Validates candidate creation options.
 *
 * @param {object} options helper options
 */
function validateCreateOptions (options) {
  if (!options.testFile) throw new Error('Missing --test-file.')
  if (fs.existsSync(options.testFile)) {
    throw new Error(`Temporary Test Management test already exists: ${options.testFile}`)
  }
}

/**
 * Gets properties for a Test Management mode.
 *
 * @param {string} mode Test Management mode
 * @returns {object} Test Management properties
 */
function getProperties (mode) {
  return {
    attempt_to_fix: mode === 'attempt-to-fix',
    disabled: mode === 'disabled',
    quarantined: mode === 'quarantined',
  }
}

/**
 * Gets temporary test source for a framework.
 *
 * @param {string} framework test framework
 * @param {string} mode Test Management mode
 * @param {string} testName test name
 * @param {string} markerFile marker file path
 * @returns {string} source
 */
function getTemporaryTestSource (framework, mode, testName, markerFile) {
  if (framework === 'vitest') {
    return [
      'import fs from \'node:fs\'',
      'import path from \'node:path\'',
      'import { describe, it } from \'vitest\'',
      '',
      getBehaviorFunctionSource(mode, markerFile),
      '',
      'describe(\'dd trace test management debug\', () => {',
      `  it(${JSON.stringify(testName)}, () => {`,
      '    runManagedCandidate()',
      '  })',
      '})',
      '',
    ].join('\n')
  }

  const testFunction = framework === 'jest' ? 'test' : 'it'

  return [
    '\'use strict\'',
    '',
    'const fs = require(\'node:fs\')',
    'const path = require(\'node:path\')',
    '',
    getBehaviorFunctionSource(mode, markerFile),
    '',
    'describe(\'dd trace test management debug\', () => {',
    `  ${testFunction}(${JSON.stringify(testName)}, () => {`,
    '    runManagedCandidate()',
    '  })',
    '})',
    '',
  ].join('\n')
}

/**
 * Gets the deterministic candidate behavior function.
 *
 * @param {string} mode Test Management mode
 * @param {string} markerFile marker file path
 * @returns {string} source
 */
function getBehaviorFunctionSource (mode, markerFile) {
  const lines = [
    'function runManagedCandidate () {',
    '  if (process.env.DD_TEST_OPTIMIZATION_TM_BASELINE === \'1\') return',
  ]

  if (mode === 'attempt-to-fix') {
    lines.push(
      `  const markerFile = path.resolve(${JSON.stringify(markerFile)})`,
      '  fs.mkdirSync(path.dirname(markerFile), { recursive: true })',
      '  if (fs.existsSync(markerFile)) {',
      '    throw new Error(\'dd trace test management attempt-to-fix retry failure\')',
      '  }',
      String.raw`  fs.writeFileSync(markerFile, 'first attempt\n')`
    )
  } else {
    lines.push(`  throw new Error(${JSON.stringify(`dd trace test management ${mode} candidate executed`)})`)
  }

  lines.push('}')

  return lines.join('\n')
}

/**
 * Appends a path to a newline-delimited state file.
 *
 * @param {string} file state file
 * @param {string} value value to append
 */
function appendStateFile (file, value) {
  const existing = new Set(readStateFile(file))
  existing.add(value)
  fs.writeFileSync(file, `${[...existing].join('\n')}\n`)
}

/**
 * Reads a newline-delimited state file.
 *
 * @param {string} file state file
 * @returns {string[]} state values
 */
function readStateFile (file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Reads a JSON file.
 *
 * @param {string} file JSON file
 * @returns {object} parsed JSON
 */
function readJsonFile (file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
}

/**
 * Gets the first known test from a known-tests map.
 *
 * @param {object} knownTests known-tests map
 * @param {string} knownTestsFile known-tests file name for errors
 * @returns {{framework: string, suite: string, testName: string}} first known test
 */
function getFirstKnownTest (knownTests, knownTestsFile) {
  for (const [framework, suites] of Object.entries(knownTests || {})) {
    for (const [suite, tests] of Object.entries(suites || {})) {
      if (Array.isArray(tests) && tests.length > 0) {
        return {
          framework,
          suite,
          testName: tests[0],
        }
      }
    }
  }

  throw new Error(`Could not infer Test Management helper arguments from ${knownTestsFile}.`)
}

/**
 * Gets a temporary Test Management sibling test path for a mode.
 *
 * @param {string} suite selected known test suite path
 * @param {string} mode Test Management mode
 * @returns {string} temporary Test Management test file
 */
function getTemporaryTestManagementFile (suite, mode) {
  return path.join(path.dirname(suite), `dd-trace-tm-${mode}${getTestFileSuffix(suite)}`)
}

/**
 * Gets the mode-specific command state file.
 *
 * @param {string} mode Test Management mode
 * @returns {string} command state file
 */
function getModeCommandFile (mode) {
  return `dd-test-optimization-tm-${mode}-command.txt`
}

/**
 * Prints an inferred Test Management plan.
 *
 * @param {object} plan inferred plan
 */
function printAutoTestManagementPlan (plan) {
  console.log('Test Management helper plan:')
  console.log(`Mode: ${plan.mode}`)
  console.log(`Settings mode: ${plan.settingsMode}`)
  console.log(`Framework: ${plan.framework}`)
  console.log(`Temporary Test Management test file: ${plan.testFile}`)
  console.log(`Test Management command: ${plan.testCommand}`)
}

/**
 * Formats a test identity for console output.
 *
 * @param {object} identity test identity
 * @returns {string} formatted identity
 */
function formatIdentity (identity) {
  return [identity.framework, identity.suite, identity.name].filter(Boolean).join(' | ')
}

/**
 * Removes the diagnostic directory when no files remain.
 */
function removeEmptyDiagnosticDirectory () {
  try {
    fs.rmdirSync(DEFAULT_ARTIFACT_DIR)
  } catch {
    // Keep non-empty diagnostic artifacts.
  }
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2))

  try {
    if (options.help) {
      console.log(getHelpText())
    } else if (options.unknown) {
      console.error(`Unknown argument: ${options.unknown}`)
      console.error(getHelpText())
      process.exitCode = 1
    } else if (options.restore) {
      restoreTestManagementChecks()
    } else if (options.auto && options.dryRun) {
      dryRunAutoTestManagementPlan(options)
    } else if (options.auto) {
      writeAutoTestManagementPlan(options)
    } else if (options.create) {
      createTestManagementCandidate(options)
    } else if (options.response) {
      buildTestManagementResponse(options)
    } else {
      console.error(getHelpText())
      process.exitCode = 1
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = {
  buildTestManagementResponse,
  createTestManagementCandidate,
  dryRunAutoTestManagementPlan,
  getProperties,
  getTemporaryTestSource,
  inferTestManagementPlan,
  parseArgs,
  restoreTestManagementChecks,
  writeAutoTestManagementPlan,
}
