'use strict'

/* eslint-disable no-console */

const fs = require('node:fs')
const path = require('node:path')

const {
  buildTestManagementTestsFromArtifact,
} = require('./test-optimization-intake-analysis')

const DEFAULT_ARTIFACT_DIR = 'dd-test-optimization-test-management'
const DEFAULT_IDENTITY_FILE = path.join(DEFAULT_ARTIFACT_DIR, 'identity.json')
const DEFAULT_MARKER_FILE = path.join(DEFAULT_ARTIFACT_DIR, 'attempt-to-fix-marker')
const DEFAULT_RESPONSE_FILE = path.join(DEFAULT_ARTIFACT_DIR, 'test-management-tests.json')
const DEFAULT_SNIPPET_FILE = path.join(DEFAULT_ARTIFACT_DIR, 'candidate-snippet.txt')
const GENERATED_FILES_STATE = path.join(DEFAULT_ARTIFACT_DIR, 'generated-files.txt')
const MARKER_FILES_STATE = path.join(DEFAULT_ARTIFACT_DIR, 'marker-files.txt')
const MODES = new Set(['disabled', 'quarantined', 'attempt-to-fix'])
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
    } else if (arg === '--mode') {
      options.mode = args[++i]
    } else if (arg.startsWith('--mode=')) {
      options.mode = arg.slice('--mode='.length)
    } else if (arg === '--framework') {
      options.framework = args[++i]
    } else if (arg.startsWith('--framework=')) {
      options.framework = arg.slice('--framework='.length)
    } else if (arg === '--test-file') {
      options.testFile = args[++i]
    } else if (arg.startsWith('--test-file=')) {
      options.testFile = arg.slice('--test-file='.length)
    } else if (arg === '--test-name') {
      options.testName = args[++i]
    } else if (arg.startsWith('--test-name=')) {
      options.testName = arg.slice('--test-name='.length)
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
    '  dd-trace TM helper --create --mode <disabled|quarantined|attempt-to-fix> ' +
      '--framework <mocha|jest|vitest> --test-file <file>',
    '  dd-trace TM helper --response --mode <disabled|quarantined|attempt-to-fix> ' +
      '--baseline-intake <intake.json>',
    '  dd-trace TM helper --restore',
    '',
    'Creates temporary Test Management candidate tests and builds calibrated modules JSON from a baseline run.',
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
  getProperties,
  getTemporaryTestSource,
  parseArgs,
  restoreTestManagementChecks,
}
