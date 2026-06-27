'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')

// Point the tracer at this variant's per-core agent (port matches `agent.js`)
// before `getConfig()` reads the URL. Set it unconditionally so a globally
// inherited `DD_TRACE_AGENT_URL` can't redirect us back to a shared port that
// another parallel variant owns.
process.env.DD_TRACE_AGENT_URL = `http://127.0.0.1:${8080 + Number(process.env.CPU_AFFINITY || 0)}`

// The trace-context expression the devtools client evaluates on the paused frame
// for every hit does `global.require('dd-trace')`. This bench loads the tracer by
// relative path, so the bare specifier would otherwise throw MODULE_NOT_FOUND on
// every hit and skew the measurement. Resolve it to this checkout's entry point.
const ddTraceEntry = require.resolve('../../..')
const originalResolveFilename = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  return originalResolveFilename.call(this, request === 'dd-trace' ? ddTraceEntry : request, ...rest)
}

// The global snapshot cap (MAX_SNAPSHOTS_PER_SECOND_GLOBALLY) is read in the
// devtools worker thread at module load, with no config or env path to override
// it. Rewrite the on-disk value before `start()` spawns the worker so the snapshot
// variants measure capture cost on every hit instead of the rate-limited path.
// No-op unless the variant opts in via the env var.
patchGlobalSnapshotCap(process.env.MAX_SNAPSHOTS_PER_SECOND_GLOBALLY)

// Entry point normally primes this; bench imports src directly.
globalThis[Symbol.for('dd-trace')] ??= { beforeExitHandlers: new Set() }

const getConfig = require('../../../packages/dd-trace/src/config')
const { start } = require('../../../packages/dd-trace/src/debugger')
const { generateProbeConfig } = require('../../../packages/dd-trace/test/debugger/devtools_client/utils')

const sourceFile = process.env.BREAKPOINT_FILE
const line = Number(process.env.BREAKPOINT_LINE)
assert(sourceFile, 'BREAKPOINT_FILE environment variable must be set')
assert(!Number.isNaN(line), 'BREAKPOINT_LINE environment variable must be a number')

const breakpoint = { sourceFile, line }

/**
 * Parse an integer environment variable, returning undefined when it is unset so
 * the probe config falls back to its defaults.
 *
 * @param {string} name
 * @returns {number | undefined}
 */
function intEnv (name) {
  return process.env[name] ? parseInt(process.env[name], 10) : undefined
}

/**
 * Replace `filePath` with `content` atomically, so the devtools worker's
 * concurrent `require('./defaults')` read in another variant only ever sees
 * complete file contents, never a half-written file.
 *
 * @param {string} filePath
 * @param {string} content
 */
function writeFileAtomic (filePath, content) {
  const tempPath = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(tempPath, content)
  fs.renameSync(tempPath, filePath)
}

/**
 * Raise `MAX_SNAPSHOTS_PER_SECOND_GLOBALLY` in the devtools defaults file to `cap`
 * and restore the committed default on exit.
 *
 * `runall.sh` pins one variant per core, so the two snapshot variants rewrite this
 * shared file in parallel. Two properties keep that race-free without a lock (a
 * lock would serialize startup and inflate the measured run): a sibling that has
 * already raised the cap is left to restore it, so its value is never captured as
 * the baseline; and the restore runs on exit, long after every worker has read the
 * cap at load, so no worker can observe the default mid-run.
 *
 * @param {string | undefined} value Desired cap; skips the rewrite when unset.
 */
function patchGlobalSnapshotCap (value) {
  if (!value) return

  const cap = Number(value)
  assert(Number.isInteger(cap) && cap > 0, 'MAX_SNAPSHOTS_PER_SECOND_GLOBALLY must be a positive integer')

  const defaultsPath = require.resolve('../../../packages/dd-trace/src/debugger/devtools_client/defaults')
  const pattern = /(MAX_SNAPSHOTS_PER_SECOND_GLOBALLY:\s*)(\d+)/
  const committed = fs.readFileSync(defaultsPath, 'utf8')
  const match = committed.match(pattern)
  assert(match, 'MAX_SNAPSHOTS_PER_SECOND_GLOBALLY not found in defaults file')

  // Already raised by a sibling variant: leave its exit handler to restore it.
  if (Number(match[2]) === cap) return

  writeFileAtomic(defaultsPath, committed.replace(pattern, `$1${cap}`))
  process.once('exit', () => writeFileAtomic(defaultsPath, committed))
}

/**
 * Install the Dynamic Instrumentation probe and run `onProbeInstalled` once the
 * breakpoint is live. The ack fires only after `Debugger.setBreakpoint` resolves,
 * so the caller runs against an installed breakpoint instead of racing it.
 *
 * @param {() => void} onProbeInstalled
 */
module.exports = function startDebugger (onProbeInstalled) {
  const config = getConfig()
  const rc = {
    setProductHandler (product, cb) {
      const action = 'apply'
      const conf = generateProbeConfig(breakpoint, {
        captureSnapshot: process.env.CAPTURE_SNAPSHOT === 'true',
        capture: {
          maxReferenceDepth: intEnv('MAX_REFERENCE_DEPTH'),
          maxCollectionSize: intEnv('MAX_COLLECTION_SIZE'),
          maxFieldCount: intEnv('MAX_FIELD_COUNT'),
          maxLength: intEnv('MAX_LENGTH'),
        },
        // Capture on every hit: a rate above 1e9 rounds nsBetweenSampling down to 0n,
        // disabling the per-probe limiter (generateProbeConfig defaults it to 5000/sec) so the
        // captured count tracks OPERATIONS instead of wall-clock time. The raised global cap
        // (MAX_SNAPSHOTS_PER_SECOND_GLOBALLY) still bounds it.
        sampling: { snapshotsPerSecond: 1e10 },
      })
      cb(action, conf, 'id', (error) => {
        if (error) throw error
        onProbeInstalled()
      })
    },
  }

  start(config, rc)

  assert.ok(globalThis[Symbol.for('dd-trace')].utilTypes, 'debugger.start did not populate utilTypes')
}
