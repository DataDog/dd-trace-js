'use strict'

/* eslint-disable eslint-rules/eslint-process-env */

const fs = require('node:fs')
const path = require('node:path')

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
  if (path.isAbsolute(executable) || executable.includes(path.sep)) {
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

  if (path.isAbsolute(executable) || executable.includes(path.sep)) {
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

module.exports = { getResolvedExecutable, getUnavailableExecutable }
