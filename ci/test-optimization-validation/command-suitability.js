'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { sanitizeString } = require('./redaction')

const MAX_CONFIG_BYTES = 512 * 1024

/**
 * Returns why a planned command cannot reliably start the selected runner.
 * Project dependency and test-collection behavior belongs to the approved clean preflight.
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

  const packageScriptError = getPackageScriptForwardingError(command, repositoryRoot)
  if (packageScriptError) return packageScriptError

  if (framework.framework === 'vitest') {
    return getExplicitVitestTypecheckError(command, label.includes('advanced-feature'), repositoryRoot)
  }
}

/**
 * Rejects package-manager separators that become a literal runner argument.
 *
 * @param {object} command structured command
 * @param {string} repositoryRoot repository root
 * @returns {string|undefined} forwarding error
 */
function getPackageScriptForwardingError (command, repositoryRoot) {
  const expansion = getPackageScriptExpansion(command, repositoryRoot)
  if (!expansion || !['pnpm', 'yarn'].includes(expansion.packageManager)) return
  if (expansion.forwardedArgs[0] !== '--') return

  return `expands package script ${JSON.stringify(expansion.scriptName)} to ` +
    `${JSON.stringify(sanitizeString(expansion.effectiveCommand))}, including a literal extra "--" before the ` +
    'runner arguments. Append focused runner arguments directly after the script name.'
}

/**
 * Returns a bounded readable package-script expansion for a structured command.
 *
 * @param {object} command structured command
 * @param {string} repositoryRoot repository root
 * @returns {object|undefined} package script expansion
 */
function getPackageScriptExpansion (command, repositoryRoot) {
  if (command.usesShell || !Array.isArray(command.argv)) return
  const argv = command.argv
  let packageManager = path.basename(argv[0] || '').replace(/\.cmd$/i, '').toLowerCase()
  let runIndex = 1
  if (packageManager === 'corepack' && ['pnpm', 'yarn'].includes(argv[1])) {
    packageManager = argv[1]
    runIndex = 2
  }
  if (path.resolve(argv[0] || '') === path.resolve(process.execPath) && /yarn-[^/]+\.cjs$/.test(argv[1] || '')) {
    packageManager = 'yarn'
    runIndex = 2
  }
  if (!['npm', 'pnpm', 'yarn'].includes(packageManager)) return

  const invocation = argv[runIndex]
  const scriptIndex = invocation === 'run' || (packageManager === 'npm' && invocation === 'run-script')
    ? runIndex + 1
    : ['pnpm', 'yarn'].includes(packageManager) ||
      (packageManager === 'npm' && ['test', 't', 'tst', 'start', 'stop', 'restart'].includes(invocation))
        ? runIndex
        : -1
  const scriptName = packageManager === 'npm' && ['t', 'tst'].includes(argv[scriptIndex])
    ? 'test'
    : argv[scriptIndex]
  if (typeof scriptName !== 'string') return

  const packageJsonSource = readRepositoryFile(path.join(command.cwd, 'package.json'), repositoryRoot)
  if (!packageJsonSource) return
  let packageJson
  try {
    packageJson = JSON.parse(packageJsonSource)
  } catch {
    return
  }
  const script = packageJson.scripts?.[scriptName]
  if (typeof script !== 'string' || script.length > MAX_CONFIG_BYTES) return

  let forwardedArgs = argv.slice(scriptIndex + 1)
  if (packageManager === 'npm' && forwardedArgs[0] === '--') forwardedArgs = forwardedArgs.slice(1)
  return {
    effectiveCommand: [script, ...forwardedArgs].join(' '),
    forwardedArgs,
    packageManager,
    script,
    scriptName,
  }
}

/**
 * @param {{ usesShell?: boolean, argv?: string[] }} command
 * @param {string} repositoryRoot
 */
function getRepositoryYarnError (command, repositoryRoot) {
  if (command.usesShell || path.basename(command.argv?.[0] || '') !== 'yarn') return

  const releaseDirectory = path.join(repositoryRoot, '.yarn', 'releases')
  let releases
  try {
    releases = fs.readdirSync(releaseDirectory)
      .filter(filename => /^yarn-[^/]+\.cjs$/.test(filename))
      .sort()
  } catch {}
  if (releases?.length > 0) {
    const release = path.posix.join('.yarn', 'releases', releases.at(-1))
    return `uses bare "yarn", but this repository pins ${release}. Use the structured command ` +
      `argv [process.execPath, "${release}", ...] so validation does not depend on an ambient Yarn shim.`
  }

  const packageJsonSource = readRepositoryFile(path.join(repositoryRoot, 'package.json'), repositoryRoot)
  if (!packageJsonSource) return
  try {
    const packageManager = JSON.parse(packageJsonSource).packageManager
    const match = /^yarn@(\d+)(?:\.|$)/.exec(packageManager || '')
    if (match && Number(match[1]) > 1) {
      return `uses bare "yarn", but package.json requires ${packageManager}. Use an explicit Corepack command ` +
        '`argv ["corepack", "yarn", ...]` or the repository-configured `yarnPath`.'
    }
  } catch {}
}

function getExplicitVitestTypecheckError (command, generatedTest, repositoryRoot) {
  const expansion = getPackageScriptExpansion(command, repositoryRoot)
  const commandText = command.usesShell ? command.shellCommand || '' : (command.argv || []).join(' ')
  const effectiveCommand = `${commandText} ${expansion?.script || ''}`
  if (/(^|\s)--typecheck\.enabled=false(?:\s|$)/.test(effectiveCommand)) return
  if (!/(^|\s)--typecheck(?:\s|$|=)/.test(effectiveCommand)) return

  if (generatedTest) {
    return 'runs Vitest with --typecheck for generated runtime tests. Use an existing runtime-only command or ' +
      'append --typecheck.enabled=false.'
  }
  return 'runs Vitest with --typecheck for the selected direct test command. Use an existing runtime-only command ' +
    'or append --typecheck.enabled=false.'
}

function readRepositoryFile (filename, repositoryRoot) {
  try {
    const entry = fs.lstatSync(filename)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_CONFIG_BYTES) return

    const physicalRoot = fs.realpathSync(repositoryRoot)
    const physicalFilename = fs.realpathSync(filename)
    const relative = path.relative(physicalRoot, physicalFilename)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return

    return fs.readFileSync(physicalFilename, 'utf8')
  } catch {}
}

module.exports = { getCommandSuitabilityError, getPackageScriptExpansion }
