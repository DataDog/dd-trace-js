'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { bindApprovedExecutable, getApprovedExecutable } = require('./executable-approval')
const { getManifestCommands } = require('./runner-command')

/**
 * Returns the unavailable file for a direct command.
 *
 * @param {object} command validator-owned command
 * @returns {string|undefined} unavailable executable
 */
function getUnavailableExecutable (command) {
  if (!isDirectRunnerCommand(command)) return command?.argv?.[0] || 'invalid direct-runner command'
  for (const filename of [process.execPath, command.argv[1]]) {
    if (!isRegularFile(filename)) return filename
  }
}

/**
 * Returns the trusted Node.js executable used for every validation command.
 *
 * @param {object} command validator-owned command
 * @returns {string|undefined} Node.js executable
 */
function getResolvedExecutable (command) {
  return isDirectRunnerCommand(command) && isRegularFile(process.execPath)
    ? fs.realpathSync(process.execPath)
    : undefined
}

/**
 * Fingerprints and binds every runnable framework's Node.js and runner files.
 *
 * @param {object} manifest normalized manifest
 * @returns {object[]} executable identities
 */
function bindManifestExecutables (manifest) {
  const identities = []
  if (manifest.frameworks) {
    for (const framework of manifest.frameworks) {
      if (framework.status !== 'runnable') continue
      const command = getManifestCommands({ frameworks: [framework] })[0]?.[1]
      try {
        const identity = getCommandExecutableIdentity(command, manifest.repository.root)
        bindApprovedExecutable(framework.validation, identity)
        identities.push({ id: `framework:${framework.id}`, ...identity })
      } catch (error) {
        identities.push({
          id: `framework:${framework.id}`,
          unavailable: true,
          reason: error?.message || String(error),
        })
      }
    }
  }
  return identities
}

/**
 * Resolves a checksum-approved executable immediately before spawn.
 *
 * @param {object} command validator-owned command
 * @param {object} [options] resolution options
 * @param {boolean} [options.requireApproval] whether approval is mandatory
 * @returns {{argv0: string, path: string}} spawn executable
 */
function getExecutableForSpawn (command, options = {}) {
  const approved = getApprovedExecutable(command)
  if (options.requireApproval && !approved) {
    throw new Error('Direct-runner command is not bound to the approved execution plan.')
  }
  const current = getCommandExecutableIdentity(command, approved?.repositoryRoot)
  if (approved && !areExecutableIdentitiesEqual(current, approved)) {
    throw new Error('The approved Node.js or test-runner executable changed after approval.')
  }
  return { argv0: process.execPath, path: current.path }
}

/**
 * Builds the executable identity for one direct-runner command.
 *
 * @param {object} command validator-owned command
 * @param {string} repositoryRoot repository root
 * @returns {object} executable identity
 */
function getCommandExecutableIdentity (command, repositoryRoot) {
  if (!isDirectRunnerCommand(command)) {
    throw new Error('Only validator-owned `node <contained-runner> ...` commands may execute.')
  }

  repositoryRoot ||= command.cwd
  const root = fs.realpathSync(repositoryRoot)
  const node = getFileIdentity(process.execPath)
  const runner = getFileIdentity(command.argv[1])
  if (!isPathInside(root, runner.path)) {
    throw new Error(`Test-runner executable resolves outside repository.root: ${command.argv[1]}`)
  }
  return {
    argv0: process.execPath,
    path: node.path,
    sha256: node.sha256,
    repositoryRoot,
    entrypoints: [runner],
  }
}

/**
 * Compares current and approved executable identities.
 *
 * @param {object} current current identity
 * @param {object} approved approved identity
 * @returns {boolean} exact identity match
 */
function areExecutableIdentitiesEqual (current, approved) {
  return current.argv0 === approved.argv0 &&
    current.path === approved.path &&
    current.sha256 === approved.sha256 &&
    current.entrypoints?.length === approved.entrypoints?.length &&
    current.entrypoints.every((entrypoint, index) => {
      const expected = approved.entrypoints[index]
      return entrypoint.path === expected.path && entrypoint.sha256 === expected.sha256
    })
}

/**
 * Splits NODE_OPTIONS without invoking a shell or expanding variables.
 *
 * @param {string} source NODE_OPTIONS source
 * @returns {string[]} Node.js arguments
 */
function splitNodeOptions (source) {
  const args = []
  let value = ''
  let started = false
  let quote

  for (let index = 0; index < String(source).length; index++) {
    const character = source[index]
    if (character === '\0') throw new Error('NODE_OPTIONS contains a null byte.')
    if (!quote && /\s/.test(character)) {
      if (started) args.push(value)
      value = ''
      started = false
      continue
    }
    if (character === '"' || character === "'") {
      if (!quote) {
        quote = character
        started = true
        continue
      }
      if (quote === character) {
        quote = undefined
        continue
      }
    }
    const next = source[index + 1]
    if (character === '\\' && next && (next === quote || /[\s'"\\]/.test(next))) {
      value += source[++index]
    } else {
      value += character
    }
    started = true
  }
  if (quote) throw new Error('NODE_OPTIONS contains an unterminated quoted value.')
  if (started) args.push(value)
  return args
}

/**
 * Returns whether a value is an explicit filesystem executable path.
 *
 * @param {string} value candidate value
 * @param {string} [platform] target platform
 * @returns {boolean} whether the value includes explicit path syntax
 */
function isExplicitExecutablePath (value, platform = process.platform) {
  if (typeof value !== 'string') return false
  if (path.isAbsolute(value) || value.startsWith('.')) return true
  return platform === 'win32' ? /[\\/]/.test(value) : value.includes('/')
}

/**
 * Returns whether a command has the only executable shape the validator supports.
 *
 * @param {object} command command candidate
 * @returns {boolean} whether it is a direct runner
 */
function isDirectRunnerCommand (command) {
  return command?.usesShell === false &&
    Array.isArray(command.argv) &&
    command.argv.length >= 3 &&
    command.argv[0] === process.execPath &&
    path.isAbsolute(command.argv[1])
}

/**
 * Fingerprints a regular file.
 *
 * @param {string} filename file path
 * @returns {{path: string, sha256: string}} file identity
 */
function getFileIdentity (filename) {
  const physical = fs.realpathSync(filename)
  const stat = fs.lstatSync(physical)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Executable must be a regular file: ${filename}`)
  return {
    path: physical,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(physical)).digest('hex'),
  }
}

/**
 * Returns whether a path resolves to a regular file.
 *
 * @param {string} filename candidate path
 * @returns {boolean} whether the file is available
 */
function isRegularFile (filename) {
  try {
    return fs.statSync(filename).isFile()
  } catch {
    return false
  }
}

/**
 * Checks path containment.
 *
 * @param {string} root root path
 * @param {string} filename candidate path
 * @returns {boolean} whether the path is contained
 */
function isPathInside (root, filename) {
  const relative = path.relative(path.resolve(root), path.resolve(filename))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

module.exports = {
  areExecutableIdentitiesEqual,
  bindManifestExecutables,
  getCommandExecutableIdentity,
  getExecutableForSpawn,
  getManifestCommands,
  getResolvedExecutable,
  getUnavailableExecutable,
  isExplicitExecutablePath,
  splitNodeOptions,
}
