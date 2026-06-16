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
const TEST_FILE_RE = /(?:\.(?:test|spec)\.|(?:^|\/)test\/[^/]+\.)[cm]?[jt]sx?$/
const SUPPORTED_FRAMEWORKS = new Set(['jest', 'mocha', 'vitest'])
const FLAGS_WITH_VALUES = new Set([
  '--config',
  '--grep',
  '--require',
  '--reporter',
  '--timeout',
  '-c',
  '-g',
  '-r',
  '-t',
])
const UNSUPPORTED_FRAMEWORKS = [
  { id: 'node-test', name: 'Node.js test runner', packages: [], patterns: [/\bnode\s+--test\b/, /\bnode:test\b/] },
  { id: 'ava', name: 'AVA', packages: ['ava'], patterns: [/\bava\b/] },
  { id: 'tap', name: 'tap', packages: ['tap'], patterns: [/\btap\b/] },
  { id: 'jasmine', name: 'Jasmine', packages: ['jasmine'], patterns: [/\bjasmine\b/] },
  { id: 'karma', name: 'Karma', packages: ['karma'], patterns: [/\bkarma\b/] },
  { id: 'uvu', name: 'uvu', packages: ['uvu'], patterns: [/\buvu\b/] },
  { id: 'testcafe', name: 'TestCafe', packages: ['testcafe'], patterns: [/\btestcafe\b/] },
]

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
    } else if (arg === '--package-root') {
      options.packageRoot = args[++i]
    } else if (arg.startsWith('--package-root=')) {
      options.packageRoot = arg.slice('--package-root='.length)
    } else if (arg === '--preflight') {
      options.preflight = true
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
    '  --package-root <dir>  Select from a nested package directory.',
    '  --preflight           Try ranked commands and choose the first one that exits 0.',
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
  const repositoryRoot = process.cwd()
  const packageRoot = path.resolve(options.packageRoot || '.')
  const packageRootRelative = path.relative(repositoryRoot, packageRoot)
  const packageJson = readPackageJson(packageRoot)
  const framework = detectFramework(packageJson, options)
  const packageManager = detectPackageManager(packageJson, repositoryRoot)
  const candidates = getCandidateTestFiles(packageRoot)

  if (candidates.length === 0) {
    throw new Error('No clean test files with simple test(...) or it(...) callbacks were found.')
  }

  const ranked = []
  for (const file of candidates) {
    ranked.push({
      file: toRepositoryRelativePath(packageRootRelative, file),
      packageFile: file,
      score: scoreCandidate(file),
    })
  }
  ranked.sort(compareCandidates)

  const selected = options.preflight
    ? getFirstPassingSelection(packageJson, packageManager, framework, ranked, packageRootRelative)
    : ranked[0]

  return {
    command: buildTestCommand(packageJson, packageManager, framework, selected.packageFile, packageRootRelative),
    file: selected.file,
    framework,
    ignoredUnsupportedFrameworks: getUnsupportedFrameworkDetections(packageJson),
    packageManager,
    score: selected.score,
  }
}

/**
 * Reads package.json from the current directory.
 *
 * @returns {object} package.json contents
 */
function readPackageJson (packageRoot = process.cwd()) {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
}

/**
 * Detects the package manager to use for the selected command.
 *
 * @param {object} packageJson package.json contents
 * @returns {string} package manager
 */
function detectPackageManager (packageJson, repositoryRoot = process.cwd()) {
  const packageManager = packageJson.packageManager || ''

  if (packageManager.startsWith('yarn@') || fs.existsSync(path.join(repositoryRoot, 'yarn.lock'))) return 'yarn'
  if (packageManager.startsWith('pnpm@') || fs.existsSync(path.join(repositoryRoot, 'pnpm-lock.yaml'))) return 'pnpm'

  return 'npm'
}

/**
 * Detects the primary test framework.
 *
 * @param {object} packageJson package.json contents
 * @param {object} [options] detection options
 * @param {string} [options.framework] requested framework
 * @returns {string} framework
 */
function detectFramework (packageJson, options = {}) {
  const requested = normalizeFramework(options.framework)
  const scripts = packageJson.scripts || {}
  const deps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  }
  const testScript = scripts.test || ''
  const unsupported = getUnsupportedFrameworkDetections(packageJson)

  if (requested) {
    if (!SUPPORTED_FRAMEWORKS.has(requested)) {
      const unsupportedMatch = unsupported.find(framework => framework.id === requested)
      const name = unsupportedMatch?.name || options.framework

      throw new Error(
        `${name} is not supported by this selector. Do not run Test Optimization validation against ` +
        'unsupported frameworks; choose jest, mocha, or vitest, or write a supported command manually.'
      )
    }

    if (!hasFrameworkEvidence(requested, testScript, deps)) {
      throw new Error(`Framework "${requested}" was requested but was not detected in package.json.`)
    }

    return requested
  }

  if (/\bvitest\b/.test(testScript) || deps.vitest) return 'vitest'
  if (/\bmocha\b/.test(testScript) || deps.mocha) return 'mocha'
  if (/\bjest\b/.test(testScript) || deps.jest) return 'jest'

  if (unsupported.length > 0) {
    throw new Error(
      `Only unsupported test framework(s) were detected: ${unsupported.map(framework => framework.name).join(', ')}. ` +
      'Do not run the live validation against unsupported frameworks. Choose a supported framework first.'
    )
  }

  throw new Error('Could not infer test framework. Use --framework or write F0-select inputs manually.')
}

/**
 * Normalizes a framework id.
 *
 * @param {string|undefined} framework requested framework
 * @returns {string|undefined} normalized framework
 */
function normalizeFramework (framework) {
  if (!framework) return

  return String(framework).trim().toLowerCase()
}

/**
 * Checks whether package.json contains evidence for a framework.
 *
 * @param {string} framework framework id
 * @param {string} testScript package test script
 * @param {object} deps package dependencies
 * @returns {boolean} whether the framework was detected
 */
function hasFrameworkEvidence (framework, testScript, deps) {
  if (framework === 'jest') return /\bjest\b/.test(testScript) || !!deps.jest || !!deps['@jest/core']
  if (framework === 'mocha') return /\bmocha\b/.test(testScript) || !!deps.mocha
  if (framework === 'vitest') return /\bvitest\b/.test(testScript) || !!deps.vitest

  return false
}

/**
 * Gets unsupported framework detections from package.json scripts and dependencies.
 *
 * @param {object} packageJson package.json contents
 * @returns {Array<object>} unsupported framework detections
 */
function getUnsupportedFrameworkDetections (packageJson) {
  const scripts = packageJson.scripts || {}
  const deps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  }
  const scriptText = Object.values(scripts).join('\n')
  const detections = []

  for (const framework of UNSUPPORTED_FRAMEWORKS) {
    const hasPackage = framework.packages.some(name => deps[name])
    const hasCommand = framework.patterns.some(pattern => pattern.test(scriptText))

    if (hasPackage || hasCommand) {
      detections.push({
        id: framework.id,
        name: framework.name,
      })
    }
  }

  return detections
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
  const dirtyPaths = getDirtyGitPaths(root)

  for (const file of files) {
    if (isIgnoredPath(file)) continue
    if (isDirtyGitPath(root, file, dirtyPaths)) continue

    const source = readFile(path.join(root, file))
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
  const gitFiles = listGitFiles(root)
  if (gitFiles) {
    return gitFiles.filter(file => TEST_FILE_RE.test(file))
  }

  const files = []
  walk(root, files, root)

  return files
}

/**
 * Lists git-tracked files.
 *
 * @returns {string[]|undefined} git files when inside a worktree
 */
function listGitFiles (root) {
  const result = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) return

  return result.stdout.split(/\r?\n/).filter(Boolean)
}

/**
 * Walks a directory and collects test files.
 *
 * @param {string} directory directory to walk
 * @param {string[]} files collected files
 */
function walk (directory, files, root) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      walk(path.join(directory, entry.name), files, root)
    } else if (entry.isFile()) {
      const file = path.relative(root, path.join(directory, entry.name))
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
function getDirtyGitPaths (root) {
  const dirtyPaths = new Set()
  let isGitWorktree = false

  for (const args of [
    ['diff', '--name-only'],
    ['diff', '--name-only', '--cached'],
  ]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
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
function isDirtyGitPath (root, file, dirtyPaths) {
  if (dirtyPaths) return dirtyPaths.has(file)

  const result = spawnSync('git', ['status', '--porcelain', '--', file], { cwd: root, encoding: 'utf8' })
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
 * Gets the first candidate whose generated command exits 0.
 *
 * @param {object} packageJson package.json contents
 * @param {string} packageManager package manager
 * @param {string} framework selected framework
 * @param {Array<object>} ranked ranked candidates
 * @param {string} packageRootRelative package root relative to the repository root
 * @returns {object} selected candidate
 */
function getFirstPassingSelection (packageJson, packageManager, framework, ranked, packageRootRelative) {
  for (const candidate of ranked.slice(0, 8)) {
    const command = buildTestCommand(packageJson, packageManager, framework, candidate.packageFile, packageRootRelative)
    const result = spawnSync(command, {
      cwd: process.cwd(),
      encoding: 'utf8',
      shell: true,
      stdio: 'pipe',
      timeout: 120_000,
    })

    if (result.status === 0) return candidate
  }

  return ranked[0]
}

/**
 * Converts a package-relative file to a repository-relative path.
 *
 * @param {string} packageRootRelative package root relative to the repository root
 * @param {string} file package-relative file path
 * @returns {string} repository-relative file path
 */
function toRepositoryRelativePath (packageRootRelative, file) {
  if (!packageRootRelative) return file

  return normalizeRelativePath(path.join(packageRootRelative, file))
}

/**
 * Normalizes path separators for command artifacts.
 *
 * @param {string} file file path
 * @returns {string} normalized relative path
 */
function normalizeRelativePath (file) {
  return file.split(path.sep).join('/')
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
function buildTestCommand (packageJson, packageManager, framework, file, packageRootRelative = '') {
  const script = getFrameworkScript(packageJson.scripts || {}, framework)
  const quotedFile = quoteShellArg(file)
  const jestFlag = framework === 'jest' ? ' --runInBand' : ''
  let command

  if (script && !testScriptUsesUnsupportedFramework(script.command)) {
    if (testScriptHasHardcodedTestTarget(script.command)) {
      command = buildDirectCommandFromScript(script.command, framework, quotedFile) ||
        buildDirectTestCommand(framework, quotedFile)
    } else if (packageManager === 'yarn') {
      command = script.name === 'test'
        ? `yarn test ${quotedFile}${jestFlag}`
        : `yarn ${quoteShellArg(script.name)} ${quotedFile}${jestFlag}`
    } else if (packageManager === 'pnpm') {
      command = script.name === 'test'
        ? `pnpm test ${quotedFile}${jestFlag}`
        : `pnpm run ${quoteShellArg(script.name)} ${quotedFile}${jestFlag}`
    } else {
      command = script.name === 'test'
        ? `npm test -- ${quotedFile}${jestFlag}`
        : `npm run ${quoteShellArg(script.name)} -- ${quotedFile}${jestFlag}`
    }
  } else {
    command = buildDirectTestCommand(framework, quotedFile)
  }

  return withPackageRoot(command, packageRootRelative)
}

/**
 * Gets the best package script for a framework.
 *
 * @param {object} scripts package scripts
 * @param {string} framework selected framework
 * @returns {{name: string, command: string}|undefined} matching script
 */
function getFrameworkScript (scripts, framework) {
  const candidates = []

  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string') continue
    if (!testScriptUsesFramework(command, framework)) continue
    if (isBenchmarkScript(name, command)) continue

    candidates.push({
      command,
      name,
      score: scoreScript(name, command),
    })
  }

  candidates.sort((left, right) => left.score - right.score || left.name.localeCompare(right.name))
  return candidates[0]
}

/**
 * Scores a script for small-file validation.
 *
 * @param {string} name script name
 * @param {string} command script command
 * @returns {number} script score
 */
function scoreScript (name, command) {
  let score = 100

  if (name === 'test') score -= 30
  if (/^(?:ci|test:unit|unit|test:ci)$/.test(name)) score -= 45
  if (/lint|typecheck|build/.test(command)) score += 80
  if (testScriptHasHardcodedTestTarget(command)) score += 25

  return score
}

/**
 * Checks whether a script is a benchmark command.
 *
 * @param {string} name script name
 * @param {string} command script command
 * @returns {boolean} whether the script is benchmark-only
 */
function isBenchmarkScript (name, command) {
  return /\bbench(?:mark)?\b/i.test(name) || /\bvitest\s+bench\b/.test(command)
}

/**
 * Wraps a command so it runs from a nested package root.
 *
 * @param {string} command command to run
 * @param {string} packageRootRelative package root relative to the repository root
 * @returns {string} wrapped command
 */
function withPackageRoot (command, packageRootRelative) {
  if (!packageRootRelative) return command

  return `cd ${quoteShellArg(packageRootRelative)} && ${command}`
}

/**
 * Builds a direct local runner command for one selected file.
 *
 * @param {string} framework selected framework
 * @param {string} quotedFile selected test file
 * @returns {string} selected test command
 */
function buildDirectTestCommand (framework, quotedFile) {
  if (framework === 'jest') return `./node_modules/.bin/jest ${quotedFile} --runInBand`
  if (framework === 'mocha') return `./node_modules/.bin/mocha ${quotedFile}`
  if (framework === 'vitest') return `./node_modules/.bin/vitest run ${quotedFile}`

  throw new Error(`Could not build a selected command for framework: ${framework}`)
}

/**
 * Builds a direct local runner command from a package script while dropping broad baked-in test targets.
 *
 * @param {string} testScript package test script
 * @param {string} framework selected framework
 * @param {string} quotedFile selected test file
 * @returns {string|undefined} selected direct command
 */
function buildDirectCommandFromScript (testScript, framework, quotedFile) {
  const words = splitShellWords(testScript)
  const runnerIndex = words.findIndex(word => shellWordMatchesRunner(word, framework))
  if (runnerIndex === -1) return

  const prefix = words.slice(0, runnerIndex)
  const runner = getLocalRunner(framework)
  const args = []

  for (let i = runnerIndex + 1; i < words.length; i++) {
    const word = words[i]
    args.push(word)

    if (FLAGS_WITH_VALUES.has(word) && i + 1 < words.length) {
      args.push(words[++i])
    }
  }

  const filteredArgs = []
  for (let i = 0; i < args.length; i++) {
    const word = args[i]

    if (FLAGS_WITH_VALUES.has(word) && i + 1 < args.length) {
      filteredArgs.push(word, args[++i])
      continue
    }

    if (isHardcodedTestTarget(word)) continue
    filteredArgs.push(word)
  }

  if (framework === 'jest' && !filteredArgs.includes('--runInBand')) {
    filteredArgs.push('--runInBand')
  }

  return [...prefix, runner, ...filteredArgs, quotedFile].filter(Boolean).join(' ')
}

/**
 * Splits a simple shell command into words while preserving quotes in output words.
 *
 * @param {string} command shell command
 * @returns {string[]} shell words
 */
function splitShellWords (command) {
  const words = []
  let current = ''
  let quote

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    if (quote) {
      current += char
      if (char === quote) quote = undefined
    } else if (char === '\'' || char === '"') {
      quote = char
      current += char
    } else if (/\s/.test(char)) {
      if (current) {
        words.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }

  if (current) words.push(current)
  return words
}

/**
 * Checks whether a shell word invokes the selected runner.
 *
 * @param {string} word shell word
 * @param {string} framework selected framework
 * @returns {boolean} whether the word invokes the runner
 */
function shellWordMatchesRunner (word, framework) {
  const normalized = stripOuterQuotes(word)
  if (framework === 'jest') return /(?:^|\/)(?:jest|jest\.js)$/.test(normalized)
  if (framework === 'mocha') return /(?:^|\/)(?:mocha|_mocha)$/.test(normalized)
  if (framework === 'vitest') return /(?:^|\/)vitest$/.test(normalized)

  return false
}

/**
 * Gets the local runner binary for a framework.
 *
 * @param {string} framework selected framework
 * @returns {string} local runner command
 */
function getLocalRunner (framework) {
  if (framework === 'jest') return './node_modules/.bin/jest'
  if (framework === 'mocha') return './node_modules/.bin/mocha'
  if (framework === 'vitest') return './node_modules/.bin/vitest'

  throw new Error(`Could not get local runner for framework: ${framework}`)
}

/**
 * Checks whether a package test script already contains a broad test target.
 *
 * @param {string} testScript package test script
 * @returns {boolean} whether the script hardcodes a test target
 */
function testScriptHasHardcodedTestTarget (testScript) {
  return splitShellWords(testScript).some(isHardcodedTestTarget)
}

/**
 * Checks whether a shell word looks like a baked-in test path or glob.
 *
 * @param {string} word shell word
 * @returns {boolean} whether the word is a test target
 */
function isHardcodedTestTarget (word) {
  const normalized = stripOuterQuotes(word)

  if (!normalized || normalized.startsWith('-')) return false
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(normalized)) return false
  if (normalized.includes('node_modules/')) return false

  return /^(?:\.\/)?(?:test|tests|spec|specs|e2e|integration-tests?)(?:\/|$)/.test(normalized) ||
    /(?:^|\/)__tests__(?:\/|$)/.test(normalized) ||
    /[*?]/.test(normalized) ||
    /\.(?:test|spec|cy)\.[cm]?[jt]sx?$/.test(normalized)
}

/**
 * Removes a matching pair of outer shell quotes.
 *
 * @param {string} word shell word
 * @returns {string} word without outer quotes
 */
function stripOuterQuotes (word) {
  if (word.length < 2) return word

  const first = word[0]
  const last = word[word.length - 1]
  if ((first === '\'' || first === '"') && first === last) return word.slice(1, -1)

  return word
}

/**
 * Checks whether a test script invokes the selected supported framework.
 *
 * @param {string} testScript package test script
 * @param {string} framework selected framework
 * @returns {boolean} whether the script invokes the framework
 */
function testScriptUsesFramework (testScript, framework) {
  if (framework === 'jest') return /\bjest\b/.test(testScript)
  if (framework === 'mocha') return /\bmocha\b/.test(testScript)
  if (framework === 'vitest') return /\bvitest\b/.test(testScript)

  return false
}

/**
 * Checks whether a test script invokes an unsupported framework.
 *
 * @param {string} testScript package test script
 * @returns {boolean} whether the script invokes an unsupported framework
 */
function testScriptUsesUnsupportedFramework (testScript) {
  return UNSUPPORTED_FRAMEWORKS.some(framework => framework.patterns.some(pattern => pattern.test(testScript)))
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
      if (selection.ignoredUnsupportedFrameworks.length > 0) {
        console.log(
          `Ignored unsupported framework(s): ${
            selection.ignoredUnsupportedFrameworks.map(framework => framework.name).join(', ')
          }`
        )
      }
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
  getUnsupportedFrameworkDetections,
  getCandidateTestFiles,
  parseArgs,
  quoteShellArg,
  scoreCandidate,
  selectTestCommand,
  writeSelection,
}
