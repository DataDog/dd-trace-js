'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')

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
// it. To let the snapshot variants measure capture cost on every hit instead of
// the rate-limited path, rewrite the on-disk value before `start()` spawns the
// worker. The worker captures the value into a const at load, so the install ack
// restores the file right after — the long work loop runs with the source
// unchanged. No-op unless the variant opts in via the env var.
const restoreSnapshotCap = patchGlobalSnapshotCap(process.env.MAX_SNAPSHOTS_PER_SECOND_GLOBALLY)

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
 * Rewrite `MAX_SNAPSHOTS_PER_SECOND_GLOBALLY` in the devtools defaults file to
 * `cap` and return an idempotent restore. A single-line numeric replace keeps the
 * file byte-identical except the value. The caller restores from the install ack
 * (the worker has captured the value by then); an exit handler is a fallback.
 *
 * @param {string | undefined} value Desired cap; skips the rewrite when unset.
 * @returns {() => void} Restores the original file contents (idempotent).
 */
function patchGlobalSnapshotCap (value) {
  if (!value) return () => {}

  const cap = Number(value)
  assert(Number.isInteger(cap) && cap > 0, 'MAX_SNAPSHOTS_PER_SECOND_GLOBALLY must be a positive integer')

  const defaultsPath = require.resolve('../../../packages/dd-trace/src/debugger/devtools_client/defaults')
  const pattern = /(MAX_SNAPSHOTS_PER_SECOND_GLOBALLY:\s*)\d+/
  const original = fs.readFileSync(defaultsPath, 'utf8')
  assert.match(original, pattern, 'MAX_SNAPSHOTS_PER_SECOND_GLOBALLY not found in defaults file')

  fs.writeFileSync(defaultsPath, original.replace(pattern, `$1${cap}`))

  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    fs.writeFileSync(defaultsPath, original)
  }
  process.once('exit', restore)
  return restore
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
      })
      cb(action, conf, 'id', (error) => {
        restoreSnapshotCap()
        if (error) throw error
        onProbeInstalled()
      })
    },
  }

  start(config, rc)

  assert.ok(globalThis[Symbol.for('dd-trace')].utilTypes, 'debugger.start did not populate utilTypes')
}
