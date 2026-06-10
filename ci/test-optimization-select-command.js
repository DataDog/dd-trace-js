'use strict'

/* eslint-disable no-console */

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_COMMAND_OUT = 'dd-test-optimization-selected-command.input'
const DEFAULT_FILES_OUT = 'dd-test-optimization-selected-files.input'
const IGNORED_DIRS = new Set([
  '.git',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'vendor',
])
const SIMPLE_TEST_RE = /(?:test|it)\(\s*(['"]).+?\1\s*,\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/
const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/

/**
 * Parses CLI arguments.
 *
 * @param {string[]} args command-line arguments
 * @returns {object} parsed options
 */
function parseArgs (args) {
  const options = {
    commandOut: DEFAULT_COMMAND_OUT,
    filesOut: DEFAULT_FILES_OUT,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--command-out') {
      options.commandOut = args[++i]
    } else if (arg.startsWith('--command-out=')) {
      options.commandOut = arg.slice('--command-out='.length)
    } else if (arg === '--files-out') {
      options.filesOut = args[++i]
    } else if (arg.startsWith('--files-out=')) {
      options.filesOut = arg.slice('--files-out='.length)
    } else if (arg === '--framework') {
      options.framework = args[++i]
    } else if (arg.startsWith('--framework=')) {
      options.framework = arg.slice('--framework='.length)
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
    'Usage: dd-trace-ci-select-test-command [--dry-run]',
    '',
    'Selects a small clean JavaScript test file and writes runbook F0-select inputs.',
    '',
    'Options:',
    `  --command-out <file>  Command output file. Defaults to ${DEFAULT_COMMAND_OUT}.`,
    `  --files-out <file>    Selected files output file. Defaults to ${DEFAULT_FILES_OUT}.`,
    '  --framework <name>    Force framework: jest, mocha, or vitest.',
    '  --dry-run             Print the selection without writing files.',
  ].join('\n')
}

/**
 * Selects a test command for the current repository.
 *
 * @param {object} options selection options
 * @returns {{command: string, file: string, framework: string, packageManager: string, score: number}} selection
 */
function selectTestCommand (options = {}) {
  const packageJson = readPackageJson()
  const framework = options.framework || detectFramework(packageJson)
  const packageManager = detectPackageManager(packageJson)
  const candidates = getCandidateTestFiles(process.cwd())

  if (candidates.length === 0) {
    throw new Error('No clean test files with simple test(...) or it(...) callbacks were found.')
  }

  const ranked = []
  for (const file of candidates) {
    ranked.push({
      file,
      score: scoreCandidate(file),
    })
  }
  ranked.sort(compareCandidates)

  const selected = ranked[0]

  return {
    command: buildTestCommand(packageJson, packageManager, framework, selected.file),
    file: selected.file,
    framework,
    packageManager,
    score: selected.score,
  }
}

/**
 * Reads package.json from the current directory.
 *
 * @returns {object} package.json contents
 */
function readPackageJson () {
  return JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'))
}

/**
 * Detects the package manager to use for the selected command.
 *
 * @param {object} packageJson package.json contents
 * @returns {string} package manager
 */
function detectPackageManager (packageJson) {
  const packageManager = packageJson.packageManager || ''

  if (packageManager.startsWith('yarn@') || fs.existsSync('yarn.lock')) return 'yarn'
  if (packageManager.startsWith('pnpm@') || fs.existsSync('pnpm-lock.yaml')) return 'pnpm'

  return 'npm'
}

/**
 * Detects the primary test framework.
 *
 * @param {object} packageJson package.json contents
 * @returns {string} framework
 */
function detectFramework (packageJson) {
  const scripts = packageJson.scripts || {}
  const deps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  }
  const testScript = scripts.test || ''

  if (/\bvitest\b/.test(testScript) || deps.vitest) return 'vitest'
  if (/\bmocha\b/.test(testScript) || deps.mocha) return 'mocha'
  if (/\bjest\b/.test(testScript) || deps.jest) return 'jest'

  throw new Error('Could not infer test framework. Use --framework or write F0-select inputs manually.')
}

/**
 * Gets clean candidate test files with simple callbacks.
 *
 * @param {string} root repository root
 * @returns {string[]} candidate files
 */
function getCandidateTestFiles (root) {
  const files = listTestFiles(root)
  const candidates = []
  const dirtyPaths = getDirtyGitPaths()

  for (const file of files) {
    if (isIgnoredPath(file)) continue
    if (isDirtyGitPath(file, dirtyPaths)) continue

    const source = readFile(file)
    if (!source) continue
    if (!SIMPLE_TEST_RE.test(source)) continue

    candidates.push(file)
  }

  return candidates
}

/**
 * Lists tracked or discovered test files.
 *
 * @param {string} root repository root
 * @returns {string[]} test files
 */
function listTestFiles (root) {
  const gitFiles = listGitFiles()
  if (gitFiles) {
    return gitFiles.filter(file => TEST_FILE_RE.test(file))
  }

  const files = []
  walk(root, files)

  return files
}

/**
 * Lists git-tracked files.
 *
 * @returns {string[]|undefined} git files when inside a worktree
 */
function listGitFiles () {
  const result = spawnSync('git', ['ls-files'], { encoding: 'utf8' })
  if (result.status !== 0) return

  return result.stdout.split(/\r?\n/).filter(Boolean)
}

/**
 * Walks a directory and collects test files.
 *
 * @param {string} directory directory to walk
 * @param {string[]} files collected files
 */
function walk (directory, files) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      walk(path.join(directory, entry.name), files)
    } else if (entry.isFile()) {
      const file = path.relative(process.cwd(), path.join(directory, entry.name))
      if (TEST_FILE_RE.test(file)) files.push(file)
    }
  }
}

/**
 * Checks whether a path should be ignored.
 *
 * @param {string} file repository-relative file
 * @returns {boolean} whether the file should be ignored
 */
function isIgnoredPath (file) {
  const parts = file.split(/[\\/]/)

  for (const part of parts) {
    if (IGNORED_DIRS.has(part)) return true
  }

  return false
}

/**
 * Gets tracked git paths with staged or unstaged local changes.
 *
 * @returns {Set<string>|undefined} dirty paths, or undefined outside a worktree
 */
function getDirtyGitPaths () {
  const dirtyPaths = new Set()
  let isGitWorktree = false

  for (const args of [
    ['diff', '--name-only'],
    ['diff', '--name-only', '--cached'],
  ]) {
    const result = spawnSync('git', args, { encoding: 'utf8' })
    if (result.status !== 0) continue

    isGitWorktree = true
    for (const file of result.stdout.split(/\r?\n/)) {
      if (file) dirtyPaths.add(file)
    }
  }

  return isGitWorktree ? dirtyPaths : undefined
}

/**
 * Checks whether a git path has local changes.
 *
 * @param {string} file repository-relative file
 * @param {Set<string>|undefined} dirtyPaths cached dirty paths
 * @returns {boolean} whether the file is dirty
 */
function isDirtyGitPath (file, dirtyPaths) {
  if (dirtyPaths) return dirtyPaths.has(file)

  const result = spawnSync('git', ['status', '--porcelain', '--', file], { encoding: 'utf8' })
  if (result.status !== 0) return false

  return result.stdout.trim().length > 0
}

/**
 * Reads a file.
 *
 * @param {string} file file path
 * @returns {string|undefined} file contents
 */
function readFile (file) {
  let source

  try {
    source = fs.readFileSync(path.resolve(file), 'utf8')
  } catch {}

  return source
}

/**
 * Scores a candidate test file.
 *
 * @param {string} file repository-relative file
 * @returns {number} candidate score
 */
function scoreCandidate (file) {
  const normalized = file.replaceAll(path.sep, '/')
  let score = normalized.length

  if (/^(?:e2e|integration-tests?)\//.test(normalized)) score += 2000
  if (/(?:^|\/)(?:__tests__|test)\//.test(normalized)) score -= 200
  if (/(?:scope|utils?|read|common)\.(?:test|spec)\./.test(normalized)) score -= 40
  if (/(?:upload|download|server|client|api|git|docker|browser)\.(?:test|spec)\./.test(normalized)) score += 80

  return score
}

/**
 * Compares two scored candidates.
 *
 * @param {{file: string, score: number}} left first candidate
 * @param {{file: string, score: number}} right second candidate
 * @returns {number} sort order
 */
function compareCandidates (left, right) {
  if (left.score !== right.score) return left.score - right.score
  return left.file.localeCompare(right.file)
}

/**
 * Builds the selected test command.
 *
 * @param {object} packageJson package.json contents
 * @param {string} packageManager package manager
 * @param {string} framework framework
 * @param {string} file selected test file
 * @returns {string} selected test command
 */
function buildTestCommand (packageJson, packageManager, framework, file) {
  const testScript = packageJson.scripts?.test
  const quotedFile = quoteShellArg(file)
  const jestFlag = framework === 'jest' ? ' --runInBand' : ''

  if (testScript) {
    if (packageManager === 'yarn') return `yarn test ${quotedFile}${jestFlag}`
    if (packageManager === 'pnpm') return `pnpm test ${quotedFile}${jestFlag}`
    return `npm test -- ${quotedFile}${jestFlag}`
  }

  if (framework === 'jest') return `./node_modules/.bin/jest ${quotedFile} --runInBand`
  if (framework === 'mocha') return `./node_modules/.bin/mocha ${quotedFile}`
  if (framework === 'vitest') return `./node_modules/.bin/vitest run ${quotedFile}`

  throw new Error(`Could not build a selected command for framework: ${framework}`)
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
 * Writes selection artifacts.
 *
 * @param {object} options CLI options
 * @param {{command: string, file: string, framework: string, packageManager: string}} selection selected command
 */
function writeSelection (options, selection) {
  fs.writeFileSync(path.resolve(options.commandOut), `${selection.command}\n`)
  fs.writeFileSync(path.resolve(options.filesOut), `${selection.file}\n`)
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2))

  try {
    if (options.help) {
      console.log(getHelpText())
    } else if (options.unknown) {
      throw new Error(`Unknown argument: ${options.unknown}`)
    } else {
      const selection = selectTestCommand(options)

      if (!options.dryRun) {
        writeSelection(options, selection)
      }

      console.log(`Selected test command: ${selection.command}`)
      console.log(`Selected test file: ${selection.file}`)
      console.log(`Framework: ${selection.framework}`)
      console.log(`Package manager: ${selection.packageManager}`)
      if (options.dryRun) console.log('No files written.')
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = {
  buildTestCommand,
  detectFramework,
  detectPackageManager,
  getCandidateTestFiles,
  parseArgs,
  quoteShellArg,
  scoreCandidate,
  selectTestCommand,
  writeSelection,
}
