'use strict'

const childProcess = require('node:child_process')
const workerThreads = require('node:worker_threads')

const { BOOTSTRAP_REQUIRE_ARG, applyCoverageEnv, isCoverageActive, resolveCoverageRoot } = require('./runtime')

const PATCHED = Symbol.for('dd-trace.integration-coverage.child-process-patched')

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

// Apply unconditionally: NODE_OPTIONS only affects Node descendants, so overlaying it on
// `bash`/`func`/etc. is harmless and lets a Node grandchild pick up the bootstrap. Picking
// the first non-flag arg as scriptPath gives the right cwd for plain `node script.js`
// invocations and degrades gracefully for shell commands.
function patchSpawnOptions (options, command, args) {
  let scriptPath
  for (const arg of args) {
    if (typeof arg === 'string' && !arg.startsWith('-')) {
      scriptPath = arg
      break
    }
  }
  return patchOptions(options, scriptPath)
}

function patchExecOptions (options) {
  const base = options || {}
  const env = applyCoverageEnv(base.env, { cwd: base.cwd })
  if (env === base.env) return options
  return { ...base, env }
}

/**
 * Worker threads inherit the parent's `process.env` only when the caller did not pass
 * `options.env`; once they do, the child env is exactly what the caller specified.
 * Inject our bootstrap require into the worker's NODE_OPTIONS only in that
 * caller-provided-env case so we don't clobber a customer-provided `--require` chain.
 *
 * @returns {void}
 */
function installWorkerPatch () {
  const OriginalWorker = workerThreads.Worker
  workerThreads.Worker = class extends OriginalWorker {
    constructor (filename, options) {
      const env = options?.env
      if (env && typeof env === 'object' && !env.NODE_OPTIONS) {
        options = { ...options, env: { ...env, NODE_OPTIONS: BOOTSTRAP_REQUIRE_ARG } }
      }
      super(filename, options)
    }
  }
}

/**
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

  installWorkerPatch()

  childProcess[PATCHED] = true
}

module.exports = { installPatch }
