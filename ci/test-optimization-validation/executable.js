'use strict'

/* eslint-disable eslint-rules/eslint-process-env */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { getCiWiringCommand, getLocalValidationCommand } = require('./local-command')

const APPROVED_EXECUTABLE = Symbol('approvedValidationExecutable')

/**
 * Returns an executable that is unavailable for a structured command.
 *
 * @param {object} command manifest command
 * @returns {string|undefined} unavailable executable
 */
function getUnavailableExecutable (command) {
  const executable = getExecutable(command)
  if (!executable || resolveExecutable(executable, command)) return
  return executable
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

  const environmentPath = command.env?.PATH || process.env.PATH || ''
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

  const environmentPath = command.env?.PATH || process.env.PATH || ''
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
 * Binds every executable selected by an approvable manifest command to its canonical file identity.
 *
 * @param {object} manifest loaded manifest
 * @returns {object[]} sorted executable identities included in approval material
 */
function bindManifestExecutables (manifest) {
  const identities = []
  const identitiesByPath = new Map()
  for (const [label, command, sourceCommand] of getManifestCommands(manifest)) {
    const identity = getExecutableIdentity(command, identitiesByPath)
    if (!identity) continue
    bindExecutableIdentity(command, identity)
    if (sourceCommand !== command) bindExecutableIdentity(sourceCommand, identity)
    identities.push({ label, ...identity })
  }
  return identities.sort((left, right) => left.label.localeCompare(right.label))
}

/**
 * Returns the executable identity already bound to one command.
 *
 * @param {object} command manifest or derived command
 * @returns {object|undefined} approved identity
 */
function getApprovedExecutable (command) {
  return command?.[APPROVED_EXECUTABLE]
}

/**
 * Verifies and returns the canonical executable and approved invocation name used to spawn it.
 *
 * @param {object} command command about to execute
 * @returns {{argv0: string, path: string}} approved launch identity
 */
function getExecutableForSpawn (command) {
  const approved = getApprovedExecutable(command)
  const current = getExecutableIdentity(command)
  if (!approved) {
    if (!current) throw new Error(`Command executable is unavailable: ${getExecutable(command)}`)
    return { argv0: current.invocationPath, path: current.path }
  }
  if (!current || current.invocationPath !== approved.invocationPath || current.path !== approved.path ||
    current.sha256 !== approved.sha256) {
    throw new Error(
      'The selected command executable changed after approval. Render and approve a fresh execution plan.'
    )
  }
  return { argv0: approved.invocationPath, path: approved.path }
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

function bindExecutableIdentity (command, identity) {
  Object.defineProperty(command, APPROVED_EXECUTABLE, {
    configurable: true,
    enumerable: true,
    value: identity,
    writable: false,
  })
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

module.exports = {
  bindManifestExecutables,
  getApprovedExecutable,
  getExecutableForSpawn,
  getResolvedExecutable,
  getUnavailableExecutable,
  isExplicitExecutablePath,
}
