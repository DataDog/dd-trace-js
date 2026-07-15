'use strict'

/* eslint-disable eslint-rules/eslint-process-env */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { bindApprovedExecutable, getApprovedExecutable } = require('./executable-approval')
const { getCiWiringCommand, getLocalValidationCommand } = require('./local-command')

/**
 * Returns an executable that is unavailable for a structured command.
 *
 * @param {object} command manifest command
 * @returns {string|undefined} unavailable executable
 */
function getUnavailableExecutable (command) {
  for (const executableCommand of getExecutableCommands(command)) {
    const executable = getExecutable(executableCommand)
    if (executable && !resolveExecutable(executable, executableCommand)) return executable
  }
}

/**
 * Reads the executable used to start a structured command.
 *
 * @param {object} command manifest command
 * @returns {string|undefined} command executable
 */
function getExecutable (command) {
  if (!command?.usesShell) return command?.argv?.[0]
  if (typeof command.shell === 'string' && command.shell.trim()) return command.shell.trim()
  return process.platform === 'win32'
    ? process.env.ComSpec || process.env.COMSPEC || 'cmd.exe'
    : process.env.SHELL || '/bin/sh'
}

/**
 * Resolves an executable from the command working directory or PATH.
 *
 * @param {string} executable executable name or path
 * @param {object} command manifest command
 * @returns {boolean} whether the executable can be resolved
 */
function resolveExecutable (executable, command) {
  if (isExplicitExecutablePath(executable)) {
    return isExecutable(path.resolve(command.cwd, executable))
  }

  const environmentPath = getEnvironmentPath(command)
  const extensions = getExecutableExtensions()

  for (const directory of environmentPath.split(path.delimiter)) {
    if (!directory) continue
    const resolvedDirectory = path.resolve(command.cwd, directory)
    for (const extension of extensions) {
      const filename = path.join(resolvedDirectory, `${executable}${extension}`)
      if (isExecutable(filename)) return true
    }
  }
  return false
}

/**
 * Resolves the filesystem path used for a structured command executable.
 *
 * @param {object} command manifest command
 * @returns {string|undefined} resolved executable path
 */
function getResolvedExecutable (command) {
  const executable = getExecutable(command)
  if (!executable) return

  if (isExplicitExecutablePath(executable)) {
    const filename = path.resolve(command.cwd, executable)
    return isExecutable(filename) ? filename : undefined
  }

  const environmentPath = getEnvironmentPath(command)
  const extensions = getExecutableExtensions()

  for (const directory of environmentPath.split(path.delimiter)) {
    if (!directory) continue
    const resolvedDirectory = path.resolve(command.cwd, directory)
    for (const extension of extensions) {
      const filename = path.join(resolvedDirectory, `${executable}${extension}`)
      if (isExecutable(filename)) return filename
    }
  }
}

/**
 * Returns the PATH used by a command, preserving an explicitly empty value.
 *
 * @param {object} command manifest command
 * @returns {string} command PATH
 */
function getEnvironmentPath (command) {
  if (Object.hasOwn(command.env || {}, 'PATH')) return command.env.PATH || ''
  return process.env.PATH || ''
}

/**
 * Binds every executable selected by an approvable manifest command to its canonical file identity.
 *
 * @param {object} manifest loaded manifest
 * @returns {object[]} sorted executable identities included in approval material
 */
function bindManifestExecutables (manifest) {
  const identities = []
  const identitiesByPath = new Map()
  for (const [label, command, sourceCommand] of getManifestCommands(manifest)) {
    const identity = getCommandExecutableIdentity(command, identitiesByPath)
    if (!identity) continue
    bindApprovedExecutable(command, identity)
    if (sourceCommand !== command) bindApprovedExecutable(sourceCommand, identity)
    identities.push({ label, ...identity })
  }
  return identities.sort((left, right) => left.label.localeCompare(right.label))
}

/**
 * Verifies and returns the canonical executable and approved invocation name used to spawn it.
 *
 * @param {object} command command about to execute
 * @param {{requireApproval?: boolean}} [options] verification options
 * @returns {{argv0: string, path: string}} approved launch identity
 */
function getExecutableForSpawn (command, options = {}) {
  const approved = getApprovedExecutable(command)
  const current = getCommandExecutableIdentity(command)
  if (!approved) {
    if (options.requireApproval) {
      throw new Error('The selected command executable was not covered by the approved execution plan.')
    }
    if (!current) throw new Error(`Command executable is unavailable: ${getExecutable(command)}`)
    return getLaunchIdentity(current)
  }
  if (!areExecutableIdentitiesEqual(current, approved)) {
    throw new Error(
      'The selected command executable changed after approval. Render and approve a fresh execution plan.'
    )
  }
  return getLaunchIdentity(approved)
}

/**
 * Resolves a command launcher and every executable delegated through env wrappers.
 *
 * @param {object} command manifest command
 * @param {Map<string, object>} [identitiesByPath] identities already hashed during this approval pass
 * @returns {{delegated?: object[], invocationPath: string, path: string, sha256: string}|undefined} identity tree
 */
function getCommandExecutableIdentity (command, identitiesByPath) {
  const identities = []
  for (const executableCommand of getExecutableCommands(command)) {
    const identity = getExecutableIdentity(executableCommand, identitiesByPath)
    if (!identity) return
    identities.push(identity)
  }

  const [launcher, ...delegated] = identities
  return delegated.length === 0 ? launcher : { ...launcher, delegated }
}

/**
 * Checks whether the launcher and delegated executable identities still match approval.
 *
 * @param {object|undefined} current current identity tree
 * @param {object|undefined} approved approved identity tree
 * @returns {boolean} whether every executable matches
 */
function areExecutableIdentitiesEqual (current, approved) {
  if (!current || !approved) return false
  const currentIdentities = [current, ...(current.delegated || [])]
  const approvedIdentities = [approved, ...(approved.delegated || [])]
  if (currentIdentities.length !== approvedIdentities.length) return false

  return currentIdentities.every((identity, index) => {
    const expected = approvedIdentities[index]
    return identity.invocationPath === expected.invocationPath && identity.path === expected.path &&
      identity.sha256 === expected.sha256
  })
}

/**
 * Expands nested env wrappers into the commands whose executables they delegate to.
 *
 * @param {object} command manifest command
 * @returns {object[]} launcher followed by delegated commands
 */
function getExecutableCommands (command) {
  const commands = [command]
  let current = command
  while (!current.usesShell && isEnvExecutable(current.argv?.[0])) {
    current = getEnvDelegatedCommand(current)
    commands.push(current)
  }
  return commands
}

/**
 * Returns the command executed by an env wrapper with its effective PATH and working directory.
 *
 * @param {object} command env wrapper command
 * @returns {object} delegated command
 */
function getEnvDelegatedCommand (command) {
  const parsed = parseArgv(command.argv)
  if (parsed.unsupportedEnvOption) {
    throw new Error(
      `Cannot approve env-wrapped command because option "${parsed.unsupportedEnvOption}" prevents reliable ` +
      'executable fingerprinting.'
    )
  }
  if (parsed.commandIndex >= command.argv.length) {
    throw new Error('Cannot approve env-wrapped command because it does not identify a delegated executable.')
  }
  const delegatedExecutable = command.argv[parsed.commandIndex]
  const requiresPathLookup = !isExplicitExecutablePath(delegatedExecutable)
  if (requiresPathLookup && parsed.unsetEnvNames.some(name => name.toUpperCase() === 'PATH')) {
    throw new Error('Cannot approve env-wrapped command because it removes PATH before selecting its executable.')
  }

  const env = parsed.ignoreEnvironment ? { ...parsed.prefixEnv } : { ...command.env, ...parsed.prefixEnv }
  if (requiresPathLookup && parsed.ignoreEnvironment && !Object.hasOwn(env, 'PATH')) {
    throw new Error(
      'Cannot approve env-wrapped command because it clears the environment without declaring an explicit PATH.'
    )
  }

  return {
    ...command,
    argv: command.argv.slice(parsed.commandIndex),
    cwd: parsed.workingDirectory ? path.resolve(command.cwd, parsed.workingDirectory) : command.cwd,
    env,
  }
}

/**
 * Selects the verified path and invocation name used to launch an executable.
 *
 * @param {{invocationPath: string, path: string}} identity verified executable identity
 * @returns {{argv0: string, path: string}} executable launch identity
 */
function getLaunchIdentity (identity) {
  return {
    argv0: identity.invocationPath,
    // Windows package-manager shims rely on their invoked path. The canonical target is still verified above.
    path: process.platform === 'win32' ? identity.invocationPath : identity.path,
  }
}

/**
 * Resolves one command executable to a stable canonical path and content digest.
 *
 * @param {object} command manifest command
 * @param {Map<string, object>} [identitiesByPath] identities already hashed during this approval pass
 * @returns {{invocationPath: string, path: string, sha256: string}|undefined} executable identity
 */
function getExecutableIdentity (command, identitiesByPath) {
  const resolved = getResolvedExecutable(command)
  if (!resolved) return
  const canonicalPath = fs.realpathSync(resolved)
  const cached = identitiesByPath?.get(canonicalPath)
  if (cached) return { invocationPath: resolved, ...cached }
  const stat = fs.statSync(canonicalPath)
  if (!stat.isFile()) return
  const canonicalIdentity = {
    path: canonicalPath,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(canonicalPath)).digest('hex'),
  }
  identitiesByPath?.set(canonicalPath, canonicalIdentity)
  return { invocationPath: resolved, ...canonicalIdentity }
}

/**
 * Enumerates every executable-bearing manifest command with a stable approval label.
 *
 * @param {object} manifest loaded manifest
 * @returns {Array<[string, object]>} labeled commands
 */
function getManifestCommands (manifest) {
  const commands = []
  for (const framework of manifest.frameworks || []) {
    const prefix = `framework:${framework.id}`
    const basicSource = framework.forcedLocalCommand || framework.existingTestCommand
    if (basicSource) {
      commands.push([`${prefix}:basic-reporting`, getLocalValidationCommand(framework, basicSource), basicSource])
    }
    if (framework.ciWiringCommand) {
      commands.push([`${prefix}:ci-wiring`, getCiWiringCommand(framework), framework.ciWiringCommand])
    }
    for (const [index, command] of (framework.setup?.commands || []).entries()) {
      commands.push([`${prefix}:setup:${index}`, command, command])
    }
    for (const [index, scenario] of (framework.generatedTestStrategy?.scenarios || []).entries()) {
      if (scenario.runCommand) {
        commands.push([
          `${prefix}:generated:${index}`,
          getLocalValidationCommand(framework, scenario.runCommand),
          scenario.runCommand,
        ])
      }
    }
  }
  return commands
}

/**
 * Detects explicit executable paths using platform path syntax.
 *
 * @param {string} executable executable name or path
 * @param {string} [platform] target platform
 * @returns {boolean} whether the value is a path rather than a PATH name
 */
function isExplicitExecutablePath (executable, platform = process.platform) {
  return path.isAbsolute(executable) || executable.includes('/') || (platform === 'win32' && executable.includes('\\'))
}

function getExecutableExtensions () {
  if (process.platform !== 'win32') return ['']
  return ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')]
}

/**
 * Checks whether a filesystem entry can be executed.
 *
 * @param {string} filename executable candidate
 * @returns {boolean} whether the candidate is executable
 */
function isExecutable (filename) {
  try {
    fs.accessSync(filename, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Parses structured env wrappers and runtime plumbing without executing them.
 *
 * @param {string[]} argv command arguments
 * @returns {object} parsed wrapper details
 */
function parseArgv (argv) {
  const result = {
    ignoreEnvironment: false,
    prefixAssignments: [],
    prefixEnv: {},
    unsetEnvNames: [],
    commandIndex: 0,
    corepackIndex: -1,
    pathAdjusted: false,
    unsupportedEnvOption: undefined,
    workingDirectory: undefined,
  }

  if (!Array.isArray(argv) || argv.length === 0) return result

  let index = 0
  if (isEnvExecutable(argv[index])) {
    index++
    while (index < argv.length) {
      const option = argv[index]
      if (option === '--') {
        index++
        break
      }
      if (option === '-' || option === '-i' || option === '--ignore-environment') {
        result.ignoreEnvironment = true
        index++
        continue
      }
      if (option === '-u' || option === '--unset') {
        if (typeof argv[index + 1] === 'string') result.unsetEnvNames.push(argv[index + 1])
        index += 2
        continue
      }
      const unsetMatch = /^(?:-u|--unset=)(.+)$/.exec(option)
      if (unsetMatch) {
        result.unsetEnvNames.push(unsetMatch[1])
        index++
        continue
      }
      if (option === '-C' || option === '--chdir') {
        if (typeof argv[index + 1] !== 'string') {
          result.unsupportedEnvOption = option
          break
        }
        result.workingDirectory = argv[index + 1]
        index += 2
        continue
      }
      const chdirMatch = /^(?:-C(.+)|--chdir=(.+))$/.exec(option)
      if (chdirMatch) {
        result.workingDirectory = chdirMatch[1] || chdirMatch[2]
        index++
        continue
      }
      if (option === '-S' || option === '--split-string' || /^(?:-S.+|--split-string=.+)$/.test(option)) {
        result.unsupportedEnvOption = option
        break
      }
      if (isSupportedEnvFlag(option)) {
        index++
        continue
      }
      if (option.startsWith('-')) {
        result.unsupportedEnvOption = option
        break
      }
      if (!isEnvAssignment(option)) break

      const assignment = argv[index]
      const equalsIndex = assignment.indexOf('=')
      const name = assignment.slice(0, equalsIndex)
      const value = assignment.slice(equalsIndex + 1)
      result.prefixEnv[name] = value

      if (name === 'PATH') {
        result.pathAdjusted = true
      } else {
        result.prefixAssignments.push(assignment)
      }
      index++
    }
  }

  result.commandIndex = index

  if (isNodeExecutable(argv[index]) && isCorepackScript(argv[index + 1]) && argv[index + 2]) {
    result.corepackIndex = index + 1
  }

  return result
}

function isSupportedEnvFlag (option) {
  return /^(?:-0|-v|--null|--debug|--help|--version|--list-signal-handling)$/.test(option) ||
    /^--(?:block|default|ignore)-signal(?:=.*)?$/.test(option)
}

function isEnvExecutable (value) {
  const name = getExecutableName(value)
  return name === 'env' || name === 'env.exe'
}

function isEnvAssignment (value) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)
}

function isNodeExecutable (value = '') {
  const name = getExecutableName(value)
  return name === 'node' || name === 'node.exe'
}

function isCorepackScript (value = '') {
  const name = getExecutableName(value)
  return name === 'corepack' || name === 'corepack.exe' || name === 'corepack.js'
}

function getExecutableName (value = '') {
  return String(value).split(/[\\/]/).pop().toLowerCase()
}

module.exports = {
  bindManifestExecutables,
  getApprovedExecutable,
  getExecutableForSpawn,
  getManifestCommands,
  getResolvedExecutable,
  getUnavailableExecutable,
  isEnvExecutable,
  isExplicitExecutablePath,
  isNodeExecutable,
  parseArgv,
}
