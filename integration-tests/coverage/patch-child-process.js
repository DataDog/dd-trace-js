'use strict'

const childProcess = require('node:child_process')
const workerThreads = require('node:worker_threads')

const {
  COPY_BACK_ENV,
  V8_COVERAGE_ENV,
  applyCoverageEnv,
  copyV8ProfilesSync,
  getV8CoverageDir,
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

// Apply unconditionally: NODE_V8_COVERAGE only affects Node descendants, so overlaying it on
// `bash`/`func`/etc. is harmless and lets a Node grandchild collect coverage. Picking the first
// non-flag arg as scriptPath gives the right cwd for plain `node script.js` invocations and
// degrades gracefully for shell commands.
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
 * Worker threads inherit the parent's `process.env` (including `NODE_V8_COVERAGE`) only when the
 * caller did not pass `options.env`; once they do, the child env is exactly what the caller
 * specified. Inject the coverage directory only in that caller-provided-env case, and only when
 * coverage is active, so a worker spawned with a custom env is still recorded.
 *
 * @returns {void}
 */
function installWorkerPatch () {
  const OriginalWorker = workerThreads.Worker
  workerThreads.Worker = class extends OriginalWorker {
    constructor (filename, options) {
      const env = options?.env
      if (isCoverageActive() && env && typeof env === 'object' && !env[V8_COVERAGE_ENV]) {
        options = { ...options, env: { ...env, [V8_COVERAGE_ENV]: getV8CoverageDir() } }
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
    const patched = patchOptions(n.options, modulePath)
    const child = originalFork.call(this, modulePath, n.args, patched)
    // When we preserved the child's own NODE_V8_COVERAGE (see applyCoverageEnv), fold that child's
    // profiles into the collector once it exits. This is the graceful path: the child exits on its
    // own, V8 writes its single teardown profile into the child's directory, and we copy it after —
    // never calling takeCoverage in the child, so its own coverage counters are never split. A
    // forced stop before this fires is handled in-child (child-bootstrap flush paths); the copy is
    // idempotent, so both running is harmless.
    const foreignDir = patched?.env?.[COPY_BACK_ENV] ? patched.env[V8_COVERAGE_ENV] : undefined
    if (foreignDir) {
      child.once('exit', () => { copyV8ProfilesSync(foreignDir, getV8CoverageDir()) })
    }
    return child
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
