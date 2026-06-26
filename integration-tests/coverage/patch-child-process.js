'use strict'

const childProcess = require('node:child_process')
const workerThreads = require('node:worker_threads')

const shimmer = require('../../packages/datadog-shimmer/src/shimmer')
const {
  BOOTSTRAP_REQUIRE_ARG,
  applyCoverageEnv,
  applyCoverageEnvPairs,
  isCoverageActive,
  resolveCoverageRoot,
} = require('./runtime')

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

  // shimmer copies the original's own properties onto each wrapper, so the wrapping stays
  // observationally invisible. That matters for `exec`/`execFile`, which carry a
  // `util.promisify.custom` symbol that `util.promisify` prefers over the callback form.
  const wrapSpawnLike = original => function (command, args, options) {
    const n = normalizeArgs(args, options)
    return original.call(this, command, n.args, patchSpawnOptions(n.options, command, n.args))
  }

  shimmer.wrap(childProcess, 'fork', original => function (modulePath, args, options) {
    const n = normalizeArgs(args, options)
    return original.call(this, modulePath, n.args, patchOptions(n.options, modulePath))
  })
  shimmer.wrap(childProcess, 'spawn', wrapSpawnLike)
  shimmer.wrap(childProcess, 'spawnSync', wrapSpawnLike)
  shimmer.wrap(childProcess, 'execFileSync', wrapSpawnLike)
  shimmer.wrap(childProcess, 'execFile', original => function (file, args, options, callback) {
    if (typeof args === 'function') {
      callback = args
      args = []
      options = {}
    } else if (typeof options === 'function') {
      callback = options
      options = {}
    }
    const n = normalizeArgs(args, options)
    return original.call(this, file, n.args, patchSpawnOptions(n.options, file, n.args), callback)
  })
  shimmer.wrap(childProcess, 'exec', original => function (command, options, callback) {
    if (typeof options === 'function') {
      callback = options
      options = undefined
    }
    return original.call(this, command, patchExecOptions(options), callback)
  })
  shimmer.wrap(childProcess, 'execSync', original => function (command, options) {
    return original.call(this, command, patchExecOptions(options))
  })

  installWorkerPatch()

  // fork / spawn / exec / execFile all funnel through ChildProcess.prototype.spawn after the env
  // is normalized into `options.envPairs`. Patching that one shared junction catches a spawn whose
  // caller captured a public method before this patch installed, which the public wrappers can't,
  // because the original `fork`/`exec` delegate to the module's local `spawn`, not the patched
  // export. Sync spawns don't pass through it, so they stay covered by the public wrappers above.
  if (typeof childProcess.ChildProcess?.prototype?.spawn === 'function') {
    shimmer.wrap(childProcess.ChildProcess.prototype, 'spawn', original => function (options) {
      if (Array.isArray(options?.envPairs)) {
        applyCoverageEnvPairs(options.envPairs, { cwd: options.cwd })
      }
      return original.call(this, options)
    })
  }

  childProcess[PATCHED] = true
}

module.exports = { installPatch }
