'use strict'

const childProcess = require('node:child_process')
const path = require('node:path')

const { applyCoverageEnv, isCoverageActive, resolveCoverageRoot } = require('./runtime')

const PATCHED = Symbol.for('dd-trace.integration-coverage.child-process-patched')

function isNodeCommand (command) {
  if (!command) return false
  const normalized = command.toLowerCase()
  if (normalized === process.execPath.toLowerCase()) return true
  const basename = path.basename(normalized)
  return basename === 'node' || basename === 'node.exe'
}

// Mirrors Node's own `fork`/`spawn` arg normalization.
function normalizeArgs (args, options) {
  if (args == null) return { args: [], options: options || {} }
  if (Array.isArray(args)) return { args, options: options || {} }
  return { args: [], options: args }
}

function patchOptions (options, scriptPath) {
  const ctx = { cwd: options.cwd, scriptPath }
  if (!resolveCoverageRoot(ctx)) return options
  return { ...options, env: applyCoverageEnv(options.env, ctx) }
}

function patchSpawnOptions (options, command, args) {
  if (!isNodeCommand(command)) return options
  let scriptPath
  for (const arg of args) {
    if (typeof arg === 'string' && !arg.startsWith('-')) {
      scriptPath = arg
      break
    }
  }
  return patchOptions(options, scriptPath)
}

// `exec`/`execSync` run through a shell, so argv[0] is the shell. Overlay unconditionally;
// `NODE_OPTIONS` only affects Node descendants.
function patchExecOptions (options) {
  const base = options || {}
  const env = applyCoverageEnv(base.env, { cwd: base.cwd })
  if (env === base.env) return options
  return { ...base, env }
}

/**
 * Installs monkey-patches on `child_process` so every Node.js descendant inherits the
 * coverage bootstrap. Idempotent.
 *
 * @returns {void}
 */
function installPatch () {
  if (!isCoverageActive() || childProcess[PATCHED]) return

  const originalFork = childProcess.fork
  const originalSpawn = childProcess.spawn
  const originalSpawnSync = childProcess.spawnSync
  const originalExecFile = childProcess.execFile
  const originalExecFileSync = childProcess.execFileSync
  const originalExec = childProcess.exec
  const originalExecSync = childProcess.execSync

  childProcess.fork = function (modulePath, args, options) {
    const n = normalizeArgs(args, options)
    return originalFork.call(this, modulePath, n.args, patchOptions(n.options, modulePath))
  }

  const wrapSpawnLike = original => function (command, args, options) {
    const n = normalizeArgs(args, options)
    return original.call(this, command, n.args, patchSpawnOptions(n.options, command, n.args))
  }

  childProcess.spawn = wrapSpawnLike(originalSpawn)
  childProcess.spawnSync = wrapSpawnLike(originalSpawnSync)
  childProcess.execFileSync = wrapSpawnLike(originalExecFileSync)
  function execFile (file, args, options, callback) {
    if (typeof args === 'function') {
      callback = args
      args = []
      options = {}
    } else if (typeof options === 'function') {
      callback = options
      options = {}
    }
    const n = normalizeArgs(args, options)
    return originalExecFile.call(this, file, n.args, patchSpawnOptions(n.options, file, n.args), callback)
  }
  execFile.__promisify__ = originalExecFile.__promisify__
  childProcess.execFile = execFile
  function exec (command, options, callback) {
    if (typeof options === 'function') {
      callback = options
      options = undefined
    }
    return originalExec.call(this, command, patchExecOptions(options), callback)
  }
  exec.__promisify__ = originalExec.__promisify__
  childProcess.exec = exec

  childProcess.execSync = function (command, options) {
    return originalExecSync.call(this, command, patchExecOptions(options))
  }

  childProcess[PATCHED] = true
}

module.exports = { installPatch }
