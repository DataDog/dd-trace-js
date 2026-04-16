'use strict'

const childProcess = require('node:child_process')
const path = require('node:path')

const { applyCoverageEnv, isCoverageActive, resolveCoverageRoot } = require('./runtime')

const PATCHED = Symbol.for('dd-trace.integration-coverage.child-process-patched')

/**
 * @param {string} command
 * @returns {boolean}
 */
function isNodeCommand (command) {
  if (!command) return false

  const normalized = command.toLowerCase()
  if (normalized === process.execPath.toLowerCase()) return true

  const basename = path.basename(normalized)
  return basename === 'node' || basename === 'node.exe'
}

/**
 * Mirror Node's own `fork`/`spawn` arg normalization: a nullish `args` means `options` is still
 * the third positional; a non-array object `args` is actually the options bag.
 *
 * @param {unknown} args
 * @param {unknown} options
 * @returns {{ args: unknown[], options: object }}
 */
function normalizeArgs (args, options) {
  if (args == null) return { args: [], options: options || {} }
  if (Array.isArray(args)) return { args, options: options || {} }
  return { args: [], options: args }
}

/**
 * @param {childProcess.ForkOptions} options
 * @param {string | URL} modulePath
 * @returns {childProcess.ForkOptions}
 */
function patchForkOptions (options, modulePath) {
  const coverageRoot = resolveCoverageRoot({ cwd: options.cwd, scriptPath: modulePath })
  if (!coverageRoot) return options

  return {
    ...options,
    env: applyCoverageEnv(options.env, { cwd: options.cwd, scriptPath: modulePath }),
  }
}

/**
 * @param {object} options
 * @param {string} command
 * @param {unknown[]} args
 * @returns {object}
 */
function patchSpawnOptions (options, command, args) {
  if (!isNodeCommand(command)) return options

  let scriptPath
  for (const arg of args) {
    if (typeof arg === 'string' && !arg.startsWith('-')) {
      scriptPath = arg
      break
    }
  }
  const coverageRoot = resolveCoverageRoot({ cwd: options.cwd, scriptPath })
  if (!coverageRoot) return options

  return {
    ...options,
    env: applyCoverageEnv(options.env, { cwd: options.cwd, scriptPath }),
  }
}

function installPatch () {
  if (!isCoverageActive() || childProcess[PATCHED]) return

  const originalFork = childProcess.fork
  const originalSpawn = childProcess.spawn
  const originalSpawnSync = childProcess.spawnSync
  const originalExecFile = childProcess.execFile
  const originalExecFileSync = childProcess.execFileSync

  childProcess.fork = function (modulePath, args, options) {
    const normalized = normalizeArgs(args, options)
    return originalFork.call(this, modulePath, normalized.args, patchForkOptions(normalized.options, modulePath))
  }

  function wrapSpawnLike (original) {
    return function (command, args, options) {
      const normalized = normalizeArgs(args, options)
      return original.call(
        this, command, normalized.args, patchSpawnOptions(normalized.options, command, normalized.args)
      )
    }
  }

  childProcess.spawn = wrapSpawnLike(originalSpawn)
  childProcess.spawnSync = wrapSpawnLike(originalSpawnSync)
  childProcess.execFileSync = wrapSpawnLike(originalExecFileSync)

  // `execFile` differs from `spawn` in that its last argument may be a callback.
  childProcess.execFile = function (file, args, options, callback) {
    if (typeof args === 'function') {
      callback = args
      args = []
      options = {}
    } else if (typeof options === 'function') {
      callback = options
      options = {}
    }

    const normalized = normalizeArgs(args, options)
    return originalExecFile.call(
      this, file, normalized.args, patchSpawnOptions(normalized.options, file, normalized.args), callback
    )
  }

  childProcess[PATCHED] = true
}

module.exports = {
  installPatch,
}
