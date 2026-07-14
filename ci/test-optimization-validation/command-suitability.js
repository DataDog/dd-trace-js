'use strict'

const fs = require('node:fs')
const path = require('node:path')

const MAX_CONFIG_BYTES = 512 * 1024
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

  if (framework.framework === 'vitest' &&
    (label === 'the selected test command' || label.includes('advanced-feature'))) {
    return getVitestNodeRuntimeError(command) ||
      getVitestTypecheckError(command, label.includes('advanced-feature'))
  }
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
  try {
    const stat = fs.statSync(filename)
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return false
    return TYPECHECK_ENABLED_PATTERN.test(fs.readFileSync(filename, 'utf8'))
  } catch {
    return false
  }
}

function unquote (value) {
  return value.replaceAll(/^['"]|['"]$/g, '')
}

module.exports = { getCommandSuitabilityError }
