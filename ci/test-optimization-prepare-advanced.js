'use strict'

/* eslint-disable no-console */

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const BACKUP_DIR = path.join('dd-test-optimization-efd', 'backups')
const DEFAULT_EFD_TEST_NAME = 'dd trace EFD debug temporary test'
const DEFAULT_KNOWN_TESTS_FILE = 'dd-test-optimization-known-tests.json'
const DEFAULT_TEST_COMMAND_FILE = 'dd-test-optimization-test-command.txt'
const FLAKE_MESSAGE = 'dd trace auto retry debug flake'
const STATE_FILES = {
  atrBackup: 'dd-test-optimization-atr-flaky-test-backup.txt',
  atrFile: 'dd-test-optimization-atr-flaky-test-file.txt',
  atrName: 'dd-test-optimization-atr-flaky-test-name.txt',
  atrSnippet: 'dd-test-optimization-atr-flaky-test-snippet.txt',
  efdCommand: 'dd-test-optimization-efd-command.txt',
  efdName: 'dd-test-optimization-efd-test-name.txt',
  efdSnippet: 'dd-test-optimization-efd-new-test-snippet.txt',
  efdTempFile: 'dd-test-optimization-efd-temp-test-file.txt',
}

/**
 * Parses CLI arguments.
 *
 * @param {string[]} args command-line arguments
 * @returns {object} parsed options
 */
function parseArgs (args) {
  const options = {
    efdTestName: DEFAULT_EFD_TEST_NAME,
    framework: 'jest',
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--framework') {
      options.framework = args[++i]
      options.frameworkExplicit = true
    } else if (arg.startsWith('--framework=')) {
      options.framework = arg.slice('--framework='.length)
      options.frameworkExplicit = true
    } else if (arg === '--auto') {
      options.auto = true
    } else if (arg === '--known-tests-file') {
      options.knownTestsFile = args[++i]
    } else if (arg.startsWith('--known-tests-file=')) {
      options.knownTestsFile = arg.slice('--known-tests-file='.length)
    } else if (arg === '--test-command-file') {
      options.testCommandFile = args[++i]
    } else if (arg.startsWith('--test-command-file=')) {
      options.testCommandFile = arg.slice('--test-command-file='.length)
    } else if (arg === '--efd-test-file') {
      options.efdTestFile = args[++i]
    } else if (arg.startsWith('--efd-test-file=')) {
      options.efdTestFile = arg.slice('--efd-test-file='.length)
    } else if (arg === '--efd-test-name') {
      options.efdTestName = args[++i]
    } else if (arg.startsWith('--efd-test-name=')) {
      options.efdTestName = arg.slice('--efd-test-name='.length)
    } else if (arg === '--flaky-test-file') {
      options.flakyTestFile = args[++i]
    } else if (arg.startsWith('--flaky-test-file=')) {
      options.flakyTestFile = arg.slice('--flaky-test-file='.length)
    } else if (arg === '--flaky-test-name') {
      options.flakyTestName = args[++i]
    } else if (arg.startsWith('--flaky-test-name=')) {
      options.flakyTestName = arg.slice('--flaky-test-name='.length)
    } else if (arg === '--efd-command') {
      options.efdCommand = args[++i]
    } else if (arg.startsWith('--efd-command=')) {
      options.efdCommand = arg.slice('--efd-command='.length)
    } else if (arg === '--restore') {
      options.restore = true
    } else if (arg === '--dry-run') {
      options.dryRun = true
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
    'Usage: dd-trace-ci-prepare-advanced --auto',
    '       dd-trace-ci-prepare-advanced --efd-test-file <file> --flaky-test-file <file> ' +
      '--flaky-test-name <name> --efd-command <command>',
    '',
    'Prepares common Step 7 EFD and Auto Test Retries temporary edits, or restores them.',
    '',
    'Options:',
    '  --auto                      Infer arguments from known-tests JSON and the selected command.',
    '  --framework <name>          jest, mocha, or vitest. Defaults to jest.',
    '  --known-tests-file <file>   Known-tests JSON for --auto. Defaults to dd-test-optimization-known-tests.json.',
    '  --test-command-file <file>  Selected command file for --auto. Defaults to the runbook command file.',
    '  --efd-test-file <file>      Temporary sibling test file to create.',
    '  --efd-test-name <name>      Temporary EFD test name. Defaults to the runbook name.',
    '  --flaky-test-file <file>    Existing known test file to edit.',
    '  --flaky-test-name <name>    Existing known test name to make fail once. Suite-qualified names are OK.',
    '  --efd-command <command>     Second command that runs known tests plus the new EFD test.',
    '  --dry-run                   Print inferred edit targets and verify the edit without writing files.',
    '  --restore                   Restore from recorded state files and remove the temp EFD test.',
  ].join('\n')
}

/**
 * Prepares temporary EFD and Auto Test Retries files.
 *
 * @param {object} options prepare options
 */
function prepareAdvancedChecks (options) {
  const plan = getPreparePlan(options)
  const { prepareOptions, efdSource, flakyTestFile, snippet, source } = plan
  const backup = createBackup(flakyTestFile)

  fs.mkdirSync(path.dirname(plan.efdTestFile), { recursive: true })
  fs.writeFileSync(plan.efdTestFile, efdSource)
  fs.writeFileSync(flakyTestFile, source)
  fs.writeFileSync(STATE_FILES.efdTempFile, `${prepareOptions.efdTestFile}\n`)
  fs.writeFileSync(STATE_FILES.efdName, `${prepareOptions.efdTestName}\n`)
  fs.writeFileSync(STATE_FILES.efdSnippet, efdSource)
  fs.writeFileSync(STATE_FILES.atrFile, `${prepareOptions.flakyTestFile}\n`)
  fs.writeFileSync(STATE_FILES.atrName, `${prepareOptions.flakyTestName}\n`)
  fs.writeFileSync(STATE_FILES.atrBackup, `${backup}\n`)
  fs.writeFileSync(STATE_FILES.atrSnippet, `${snippet}\n`)
  fs.writeFileSync(STATE_FILES.efdCommand, `${prepareOptions.efdCommand}\n`)

  console.log(`Temporary EFD test file: ${prepareOptions.efdTestFile}`)
  console.log(`Auto Test Retries flaky test file: ${prepareOptions.flakyTestFile}`)
  console.log(`Auto Test Retries backup: ${backup}`)
  console.log(`EFD test command: ${prepareOptions.efdCommand}`)
}

/**
 * Prints inferred temporary edits without writing files.
 *
 * @param {object} options prepare options
 */
function dryRunPrepareAdvancedChecks (options) {
  const { prepareOptions } = getPreparePlan(options)

  console.log('Advanced helper dry run:')
  console.log(`Temporary EFD test file: ${prepareOptions.efdTestFile}`)
  console.log(`Auto Test Retries flaky test file: ${prepareOptions.flakyTestFile}`)
  console.log(`Auto Test Retries flaky test name: ${prepareOptions.flakyTestName}`)
  console.log(`Framework: ${prepareOptions.framework}`)
  console.log(`EFD test command: ${prepareOptions.efdCommand}`)
  console.log('No files written.')
}

/**
 * Builds and validates the temporary edit plan.
 *
 * @param {object} options prepare options
 * @returns {object} validated plan
 */
function getPreparePlan (options) {
  const prepareOptions = options.auto ? inferPrepareOptions(options) : options
  prepareOptions.efdTestName = prepareOptions.efdTestName || DEFAULT_EFD_TEST_NAME

  validatePrepareOptions(prepareOptions)

  const efdTestFile = path.resolve(prepareOptions.efdTestFile)
  const flakyTestFile = path.resolve(prepareOptions.flakyTestFile)
  assertCleanGitFileForEdit(flakyTestFile)

  const efdSource = getTemporaryTestSource(prepareOptions.framework, prepareOptions.efdTestName)
  const flakySource = fs.readFileSync(flakyTestFile, 'utf8')
  const { source, snippet } = insertFlakyFailure(flakySource, prepareOptions.flakyTestName)

  return {
    efdSource,
    efdTestFile,
    flakyTestFile,
    prepareOptions,
    snippet,
    source,
  }
}

/**
 * Restores temporary EFD and Auto Test Retries edits.
 */
function restoreAdvancedChecks () {
  if (fs.existsSync(STATE_FILES.efdTempFile)) {
    const efdTestFile = fs.readFileSync(STATE_FILES.efdTempFile, 'utf8').trim()

    if (efdTestFile) {
      fs.rmSync(efdTestFile, { force: true })
      console.log(`Temporary EFD test removed: ${efdTestFile}`)
    }

    fs.rmSync(STATE_FILES.efdTempFile, { force: true })
  }
  fs.rmSync(STATE_FILES.efdName, { force: true })

  if (fs.existsSync(STATE_FILES.atrFile)) {
    const flakyTestFile = fs.readFileSync(STATE_FILES.atrFile, 'utf8').trim()
    const backup = fs.existsSync(STATE_FILES.atrBackup)
      ? fs.readFileSync(STATE_FILES.atrBackup, 'utf8').trim()
      : ''

    if (!backup || !fs.existsSync(backup)) {
      throw new Error('Auto Test Retries backup file is missing.')
    }

    fs.copyFileSync(backup, flakyTestFile)
    fs.rmSync(backup, { force: true })
    fs.rmSync(STATE_FILES.atrFile, { force: true })
    fs.rmSync(STATE_FILES.atrBackup, { force: true })
    fs.rmSync(STATE_FILES.atrName, { force: true })
    removeEmptyBackupDirectory()
    console.log(`Temporary Auto Test Retries edit restored: ${flakyTestFile}`)
  }
}

/**
 * Validates setup options.
 *
 * @param {object} options prepare options
 */
function validatePrepareOptions (options) {
  if (!options.efdTestFile) throw new Error('Missing --efd-test-file.')
  if (!options.flakyTestFile) throw new Error('Missing --flaky-test-file.')
  if (!options.flakyTestName) throw new Error('Missing --flaky-test-name.')
  if (!options.efdCommand) throw new Error('Missing --efd-command.')
  if (fs.existsSync(options.efdTestFile)) throw new Error(`Temporary EFD test already exists: ${options.efdTestFile}`)
  if (!fs.existsSync(options.flakyTestFile)) throw new Error(`Flaky test file does not exist: ${options.flakyTestFile}`)
}

/**
 * Infers common advanced-check options from prior runbook artifacts.
 *
 * @param {object} options auto options
 * @returns {object} inferred prepare options
 */
function inferPrepareOptions (options) {
  const knownTestsFile = options.knownTestsFile || DEFAULT_KNOWN_TESTS_FILE
  const testCommandFile = options.testCommandFile || DEFAULT_TEST_COMMAND_FILE
  const knownTests = readJsonFile(knownTestsFile)
  const selectedCommand = fs.readFileSync(path.resolve(testCommandFile), 'utf8').trim()
  const inferred = getFirstKnownTest(knownTests)
  const efdTestFile = options.efdTestFile || getTemporaryEfdTestFile(inferred.suite)

  return {
    ...options,
    efdCommand: options.efdCommand || addEfdTestFileToCommand(selectedCommand, inferred.suite, efdTestFile),
    efdTestFile,
    efdTestName: options.efdTestName || DEFAULT_EFD_TEST_NAME,
    flakyTestFile: options.flakyTestFile || inferred.suite,
    flakyTestName: options.flakyTestName || inferred.testName,
    framework: options.frameworkExplicit ? options.framework : inferred.framework,
  }
}

/**
 * Adds the temporary EFD test file next to the selected known test file in a command.
 *
 * @param {string} command selected test command
 * @param {string} selectedTestFile known test file selected by the command
 * @param {string} efdTestFile temporary EFD test file
 * @returns {string} command with the temporary EFD test file
 */
function addEfdTestFileToCommand (command, selectedTestFile, efdTestFile) {
  return addTestFileToCommand(command, selectedTestFile, efdTestFile)
}

/**
 * Adds a test file next to the selected known test file in a command.
 *
 * @param {string} command selected test command
 * @param {string} selectedTestFile known test file selected by the command
 * @param {string} testFile test file to add
 * @returns {string} command with the test file
 */
function addTestFileToCommand (command, selectedTestFile, testFile) {
  const tokens = tokenizeCommand(command)
  const insertion = ` ${quoteShellArg(testFile)}`

  for (let i = tokens.length - 1; i >= 0; i--) {
    if (isSamePathToken(tokens[i].value, selectedTestFile)) {
      return `${command.slice(0, tokens[i].end)}${insertion}${command.slice(tokens[i].end)}`
    }
  }

  return `${command}${insertion}`
}

/**
 * Tokenizes enough shell syntax to locate path arguments while preserving the original command.
 *
 * @param {string} command command string
 * @returns {Array<{start: number, end: number, value: string}>} parsed tokens
 */
function tokenizeCommand (command) {
  const tokens = []
  let index = 0

  while (index < command.length) {
    while (index < command.length && /\s/.test(command[index])) index++
    if (index >= command.length) break

    const start = index
    let quote
    let value = ''

    while (index < command.length) {
      const char = command[index]

      if (quote) {
        if (char === quote) {
          quote = undefined
          index++
        } else if (quote === '"' && char === '\\' && index + 1 < command.length) {
          value += command[index + 1]
          index += 2
        } else {
          value += char
          index++
        }
      } else if (/\s/.test(char)) {
        break
      } else if (char === '\'' || char === '"') {
        quote = char
        index++
      } else if (char === '\\' && index + 1 < command.length) {
        value += command[index + 1]
        index += 2
      } else {
        value += char
        index++
      }
    }

    tokens.push({ end: index, start, value })
  }

  return tokens
}

/**
 * Checks whether a command token points to the selected test file.
 *
 * @param {string} token command token value
 * @param {string} selectedTestFile selected test file
 * @returns {boolean} whether token points to the selected test file
 */
function isSamePathToken (token, selectedTestFile) {
  return normalizeCommandPath(token) === normalizeCommandPath(selectedTestFile)
}

/**
 * Normalizes command paths for comparison.
 *
 * @param {string} value path-like command token
 * @returns {string} normalized path
 */
function normalizeCommandPath (value) {
  return path.normalize(value).replace(/^\.\/+/, '')
}

/**
 * Quotes a shell argument only when needed.
 *
 * @param {string} value shell argument
 * @returns {string} shell-safe argument
 */
function quoteShellArg (value) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value

  return `'${value.replaceAll('\'', String.raw`'\''`)}'`
}

/**
 * Reads a JSON file.
 *
 * @param {string} file JSON file path
 * @returns {object} parsed JSON
 */
function readJsonFile (file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
}

/**
 * Gets the first known test from a known-tests map.
 *
 * @param {object} knownTests known-tests map
 * @returns {{framework: string, suite: string, testName: string}} first known test
 */
function getFirstKnownTest (knownTests) {
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

  throw new Error(`Could not infer advanced helper arguments from ${DEFAULT_KNOWN_TESTS_FILE}.`)
}

/**
 * Gets the default temporary EFD sibling test file.
 *
 * @param {string} suite selected known test suite path
 * @returns {string} temporary EFD test path
 */
function getTemporaryEfdTestFile (suite) {
  return path.join(path.dirname(suite), `dd-trace-efd-debug${getTestFileSuffix(suite)}`)
}

/**
 * Gets the suffix to reuse for a generated sibling test file.
 *
 * @param {string} suite selected known test suite path
 * @returns {string} test file suffix
 */
function getTestFileSuffix (suite) {
  const basename = path.basename(suite)
  const firstDot = basename.indexOf('.')

  if (firstDot !== -1) return basename.slice(firstDot)

  return '.test.js'
}

/**
 * Creates a temporary backup of a file.
 *
 * @param {string} file file to back up
 * @returns {string} backup path
 */
function createBackup (file) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true })

  const backupName = `${sanitizeBackupName(path.relative(process.cwd(), file))}.backup`
  const backup = path.join(BACKUP_DIR, backupName)

  if (fs.existsSync(backup)) {
    throw new Error(`Auto Test Retries backup already exists: ${backup}`)
  }

  fs.copyFileSync(file, backup)

  return backup
}

/**
 * Sanitizes a path into a backup filename.
 *
 * @param {string} file file path
 * @returns {string} filesystem-safe backup name
 */
function sanitizeBackupName (file) {
  return file.replaceAll(/[^A-Za-z0-9_.-]/g, '_') || 'flaky-test'
}

/**
 * Removes the backup directory when it is empty.
 */
function removeEmptyBackupDirectory () {
  try {
    fs.rmdirSync(BACKUP_DIR)
    fs.rmdirSync(path.dirname(BACKUP_DIR))
  } catch {
    // Leave non-empty diagnostic artifact directories in place.
  }
}

/**
 * Refuses to edit a dirty known test file inside git worktrees.
 *
 * @param {string} file file that will be temporarily edited
 */
function assertCleanGitFileForEdit (file) {
  if (!isInsideGitWorktree()) return

  const relativeFile = path.relative(process.cwd(), file)

  if (!isTrackedGitFile(relativeFile)) {
    throw new Error(`Refusing to edit untracked known test file: ${relativeFile}`)
  }

  assertGitDiffClean(['diff', '--quiet', '--', relativeFile], relativeFile)
  assertGitDiffClean(['diff', '--cached', '--quiet', '--', relativeFile], relativeFile)
}

/**
 * Checks whether the current directory is inside a git worktree.
 *
 * @returns {boolean} true when inside a git worktree
 */
function isInsideGitWorktree () {
  const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
  })

  return result.status === 0 && result.stdout.trim() === 'true'
}

/**
 * Checks whether a git path is tracked.
 *
 * @param {string} file git-relative or worktree-relative file path
 * @returns {boolean} true when git tracks the file
 */
function isTrackedGitFile (file) {
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', file], {
    encoding: 'utf8',
    stdio: 'ignore',
  })

  return result.status === 0
}

/**
 * Asserts a git diff command reports no differences.
 *
 * @param {string[]} args git arguments
 * @param {string} file rendered file path
 */
function assertGitDiffClean (args, file) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    stdio: 'ignore',
  })

  if (result.status === 0) return
  if (result.status === 1) {
    throw new Error(`Refusing to edit dirty known test file: ${file}`)
  }

  throw new Error(`Could not verify git cleanliness before editing known test file: ${file}`)
}

/**
 * Gets temporary test source for a framework.
 *
 * @param {string} framework test framework name
 * @param {string} testName test name
 * @returns {string} test source
 */
function getTemporaryTestSource (framework, testName) {
  if (framework === 'vitest') {
    return [
      'import { describe, expect, it } from \'vitest\'',
      '',
      'describe(\'dd trace EFD debug\', () => {',
      `  it(${JSON.stringify(testName)}, () => {`,
      '    expect(1 + 1).toBe(2)',
      '  })',
      '})',
      '',
    ].join('\n')
  }

  if (framework === 'mocha') {
    return [
      '\'use strict\'',
      '',
      'const assert = require(\'node:assert/strict\')',
      '',
      'describe(\'dd trace EFD debug\', () => {',
      `  it(${JSON.stringify(testName)}, () => {`,
      '    assert.strictEqual(1 + 1, 2)',
      '  })',
      '})',
      '',
    ].join('\n')
  }

  return [
    'describe(\'dd trace EFD debug\', () => {',
    `  test(${JSON.stringify(testName)}, () => {`,
    '    expect(1 + 1).toBe(2)',
    '  })',
    '})',
    '',
  ].join('\n')
}

/**
 * Inserts a one-time failure branch into a named test.
 *
 * @param {string} source original source
 * @param {string} testName test name to edit
 * @returns {{source: string, snippet: string}} edited source and snippet
 */
function insertFlakyFailure (source, testName) {
  if (source.includes(FLAKE_MESSAGE)) {
    throw new Error('Temporary Auto Test Retries flaky edit is already present.')
  }

  const counter = 'let ddTraceAutoRetryCounter = 0'
  const withCounter = insertCounter(source, counter)
  const match = findTestCallback(withCounter, testName)

  if (!match) {
    throw new Error(`Could not find a simple test(...) or it(...) callback for: ${testName}`)
  }

  const failureBranch = [
    match[1],
    '    if (ddTraceAutoRetryCounter++ === 0) {',
    `      throw new Error('${FLAKE_MESSAGE}')`,
    '    }',
    '',
  ].join('\n')
  const edited = [
    withCounter.slice(0, match.index),
    failureBranch,
    withCounter.slice(match.index + match[1].length),
  ].join('')
  const snippet = [
    counter,
    '',
    failureBranch,
  ].join('\n')

  return {
    snippet,
    source: edited,
  }
}

/**
 * Finds a simple named test callback.
 *
 * @param {string} source source code
 * @param {string} testName source-level or suite-qualified test name
 * @returns {RegExpMatchArray} test callback match
 */
function findTestCallback (source, testName) {
  const exactPattern = new RegExp(
    String.raw`((?:test|it)\(\s*(['"])${escapeRegExp(testName)}\2\s*,\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{)`
  )
  const exactMatch = source.match(exactPattern)

  if (exactMatch) return exactMatch

  const pattern = /((?:test|it)\(\s*(['"])(.*?)\2\s*,\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{)/g
  const candidates = []

  for (const match of source.matchAll(pattern)) {
    if (isSuiteQualifiedMatch(testName, match[3])) {
      candidates.push(match)
    }
  }

  if (candidates.length === 1) return candidates[0]

  if (candidates.length > 1) {
    throw new Error(`Found multiple simple test(...) or it(...) callbacks matching: ${testName}`)
  }

  throw new Error(`Could not find a simple test(...) or it(...) callback for: ${testName}`)
}

/**
 * Checks whether a source-level test name is the trailing name in a suite-qualified test name.
 *
 * @param {string} maybeSuiteQualifiedName suite-qualified or source-level test name
 * @param {string} sourceLevelName source-level test or it name
 * @returns {boolean} whether the source-level name matches the end of the suite-qualified name
 */
function isSuiteQualifiedMatch (maybeSuiteQualifiedName, sourceLevelName) {
  if (maybeSuiteQualifiedName === sourceLevelName) return true
  if (!maybeSuiteQualifiedName.endsWith(sourceLevelName)) return false

  const prefixLength = maybeSuiteQualifiedName.length - sourceLevelName.length

  return prefixLength > 0 && /\s/.test(maybeSuiteQualifiedName[prefixLength - 1])
}

/**
 * Inserts a counter after leading imports or directives.
 *
 * @param {string} source original source
 * @param {string} counter counter declaration
 * @returns {string} source with counter
 */
function insertCounter (source, counter) {
  const importEnd = getLeadingImportEnd(source)

  if (importEnd > 0) {
    return `${source.slice(0, importEnd)}${counter}\n\n${source.slice(importEnd)}`
  }

  const strictMatch = source.match(/^('use strict'\n\n?)/)

  if (strictMatch) {
    return source.replace(strictMatch[1], `${strictMatch[1]}${counter}\n\n`)
  }

  return `${counter}\n\n${source}`
}

/**
 * Finds the end offset of the leading static import block.
 *
 * @param {string} source original source
 * @returns {number} end offset, or 0 when the file does not start with imports
 */
function getLeadingImportEnd (source) {
  const lines = source.match(/^.*(?:\r?\n|$)/gm) || []
  let offset = 0
  let importEnd = 0
  let inImport = false
  let sawImport = false

  for (const line of lines) {
    if (line === '') break

    const trimmed = line.trim()

    if (!inImport && trimmed === '') break
    if (!inImport && !isStaticImportStart(trimmed)) break

    sawImport = true
    inImport = !isStaticImportEnd(trimmed)
    offset += line.length
    importEnd = offset

    if (!inImport) continue
  }

  if (!sawImport || inImport) return 0

  return importEnd
}

/**
 * Checks whether a line starts a static import statement.
 *
 * @param {string} line trimmed source line
 * @returns {boolean} whether the line starts a static import
 */
function isStaticImportStart (line) {
  return /^import(?:\s|['"{*])/.test(line)
}

/**
 * Checks whether a trimmed import line completes a static import statement.
 *
 * @param {string} line trimmed source line
 * @returns {boolean} whether the import statement is complete
 */
function isStaticImportEnd (line) {
  return (
    /^import\s+['"][^'"]+['"]\s*;?\s*$/.test(line) ||
    /\bfrom\s+['"][^'"]+['"]\s*;?\s*$/.test(line) ||
    /;\s*$/.test(line)
  )
}

/**
 * Escapes text for use in a regular expression.
 *
 * @param {string} value text value
 * @returns {string} escaped text
 */
function escapeRegExp (value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2))

  try {
    if (options.help) {
      console.log(getHelpText())
    } else if (options.unknown) {
      throw new Error(`Unknown argument: ${options.unknown}`)
    } else if (options.restore) {
      restoreAdvancedChecks()
    } else if (options.dryRun) {
      dryRunPrepareAdvancedChecks(options)
    } else {
      prepareAdvancedChecks(options)
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = {
  addTestFileToCommand,
  assertCleanGitFileForEdit,
  dryRunPrepareAdvancedChecks,
  findTestCallback,
  getPreparePlan,
  getTestFileSuffix,
  getTemporaryEfdTestFile,
  getTemporaryTestSource,
  inferPrepareOptions,
  insertFlakyFailure,
  parseArgs,
  prepareAdvancedChecks,
  restoreAdvancedChecks,
}
