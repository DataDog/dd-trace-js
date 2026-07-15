'use strict'

const fs = require('node:fs')
const path = require('node:path')

const MAX_CONFIG_BYTES = 512 * 1024
const JEST_LOCAL_PATH_PATTERN = /(['"])(<rootDir>\/[^'"\r\n]+)\1/g
const JEST_ROOT_DIR_PATTERN = /\brootDir\s*:\s*(['"])([^'"]+)\1/
const TYPECHECK_ENABLED_PATTERN = /typecheck\s*:\s*\{[\s\S]{0,2000}?enabled\s*:\s*true/
const VITEST_CONFIG_FILENAMES = [
  'vitest.config.js',
  'vitest.config.mjs',
  'vitest.config.cjs',
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.config.cts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.cts',
]

/**
 * Returns why a planned command is unsuitable for deterministic validation.
 *
 * @param {object} input suitability input
 * @param {object} input.command manifest command
 * @param {object} input.framework manifest framework
 * @param {string} input.label planned command label
 * @param {string} input.repositoryRoot repository root
 * @returns {string|undefined} suitability error
 */
function getCommandSuitabilityError ({ command, framework, label, repositoryRoot }) {
  const yarnError = getRepositoryYarnError(command, repositoryRoot)
  if (yarnError) return yarnError

  if (framework.framework === 'jest') {
    const missingInputError = getJestMissingLocalInputError(framework)
    if (missingInputError) return missingInputError
  }

  if (framework.framework === 'vitest' &&
    (label === 'the selected test command' || label.includes('advanced-feature'))) {
    return getVitestNodeRuntimeError(command) ||
      getVitestTypecheckError(command, label.includes('advanced-feature'))
  }
}

/**
 * Returns an error for an exact local file referenced by Jest config but absent before execution.
 *
 * @param {object} framework manifest framework entry
 * @returns {string|undefined} suitability error
 */
function getJestMissingLocalInputError (framework) {
  for (const configFile of framework.project?.configFiles || []) {
    const config = readConfig(configFile)
    if (!config) continue

    const rootDirMatch = config.match(JEST_ROOT_DIR_PATTERN)
    const rootDir = rootDirMatch
      ? path.resolve(path.dirname(configFile), rootDirMatch[2])
      : path.dirname(configFile)

    for (const match of config.matchAll(JEST_LOCAL_PATH_PATTERN)) {
      const configuredPath = match[2]
      if (/[$*?{}[\]]/.test(configuredPath) || !/\.(?:[cm]?[jt]sx?|json)$/.test(configuredPath)) continue

      const localPath = path.resolve(rootDir, configuredPath.slice('<rootDir>/'.length))
      if (fs.existsSync(localPath) || isProducedBySetup(framework, localPath)) continue

      return `uses Jest config ${configFile}, which references missing local input ${localPath}. ` +
        'Choose a representative whose config inputs already exist, or declare the reviewed setup command and ' +
        'its output path before marking this framework runnable.'
    }
  }
}

/**
 * Checks whether an approved setup command declares the missing input as an output.
 *
 * @param {object} framework manifest framework entry
 * @param {string} localPath missing local input
 * @returns {boolean} whether setup declares the input
 */
function isProducedBySetup (framework, localPath) {
  for (const command of framework.setup?.commands || []) {
    for (const outputPath of command.outputPaths || []) {
      const relative = path.relative(path.resolve(outputPath), localPath)
      if (relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative))) return true
    }
  }
  return false
}

function getVitestNodeRuntimeError (command) {
  if (command.usesShell || !Array.isArray(command.argv)) return

  const executable = command.argv[0]
  if (!path.isAbsolute(executable) || path.basename(executable) !== 'node') return
  if (path.resolve(executable) === path.resolve(process.execPath)) return

  return `uses the alternate Node executable ${executable} for direct Vitest validation. The validator cannot ` +
    'safely determine whether that executable supports the --import preload Vitest requires without executing ' +
    'it during plan rendering. Use "node" to inherit the active runtime, or use the validator process.execPath ' +
    `${process.execPath}. Preserve an alternate CI runtime only in ciWiringCommand.`
}

function getRepositoryYarnError (command, repositoryRoot) {
  if (command.usesShell || path.basename(command.argv?.[0] || '') !== 'yarn') return

  const releaseDirectory = path.join(repositoryRoot, '.yarn', 'releases')
  let releases
  try {
    releases = fs.readdirSync(releaseDirectory)
      .filter(filename => /^yarn-[^/]+\.cjs$/.test(filename))
      .sort()
  } catch {
    return
  }
  if (releases.length === 0) return

  const release = path.posix.join('.yarn', 'releases', releases[releases.length - 1])
  return `uses bare "yarn", but this repository pins ${release}. Use the structured command ` +
    `argv [process.execPath, "${release}", ...] so validation does not depend on an ambient Yarn shim.`
}

function getVitestTypecheckError (command, generatedTest) {
  const commandText = command.usesShell ? command.shellCommand || '' : (command.argv || []).join(' ')
  if (/(^|\s)--typecheck\.enabled=false(?:\s|$)/.test(commandText)) return
  if (/(^|\s)--typecheck(?:\s|$|=)/.test(commandText)) {
    return getTypecheckError('runs Vitest with --typecheck', generatedTest)
  }

  const configFile = getVitestConfigFile(command)
  if (!configFile || !configEnablesTypecheck(configFile)) return

  return getTypecheckError(`uses typecheck-enabled Vitest config ${configFile}`, generatedTest)
}

function getTypecheckError (prefix, generatedTest) {
  if (generatedTest) {
    return `${prefix} for generated runtime tests. Typecheck projects can count each generated test twice; use ` +
      'an existing typecheck-disabled config, or create a declared temporary config for advanced checks.'
  }
  return `${prefix} for the selected direct test command. Typecheck can duplicate runtime tests and make ` +
    'unrelated source errors fail Basic Reporting; use an existing runtime-only config or append ' +
    '`--typecheck.enabled=false`.'
}

function getVitestConfigFile (command) {
  if (command.usesShell) {
    const match = String(command.shellCommand || '').match(/(?:^|\s)--config(?:=|\s+)([^\s]+)/)
    return match ? path.resolve(command.cwd, unquote(match[1])) : undefined
  }

  const argv = command.argv || []
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--config' && argv[index + 1]) return path.resolve(command.cwd, argv[index + 1])
    if (argv[index].startsWith('--config=')) return path.resolve(command.cwd, argv[index].slice('--config='.length))
  }

  for (const filename of VITEST_CONFIG_FILENAMES) {
    const configFile = path.resolve(command.cwd, filename)
    if (isFile(configFile)) return configFile
  }
}

function isFile (filename) {
  try {
    return fs.statSync(filename).isFile()
  } catch {
    return false
  }
}

function configEnablesTypecheck (filename) {
  const config = readConfig(filename)
  return config ? TYPECHECK_ENABLED_PATTERN.test(config) : false
}

/**
 * Reads a bounded test-runner config file.
 *
 * @param {string} filename config path
 * @returns {string|undefined} config text
 */
function readConfig (filename) {
  try {
    const stat = fs.statSync(filename)
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return
    return fs.readFileSync(filename, 'utf8')
  } catch {}
}

function unquote (value) {
  return value.replaceAll(/^['"]|['"]$/g, '')
}

module.exports = { getCommandSuitabilityError }
