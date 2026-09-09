'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const workerThreads = require('node:worker_threads')

const { DEBUGGER_INPUT_V2 } = require('../../../packages/dd-trace/src/debugger/constants')
const NoopTracer = require('../../../packages/dd-trace/src/noop/tracer')
const { generateProbeConfig } = require('../../../packages/dd-trace/test/debugger/devtools_client/utils')
const { PROBE_COUNT_LENGTH } = require('./benchmark-state')

const TRACK_PROBE_OUTPUT = process.env.TRACK_PROBE_OUTPUT === 'true'
const probeCountBuffer = TRACK_PROBE_OUTPUT
  ? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * PROBE_COUNT_LENGTH)
  : undefined
const probeCounts = probeCountBuffer === undefined
  ? undefined
  : new Int32Array(probeCountBuffer)
const OriginalWorker = workerThreads.Worker

class BenchmarkWorker extends OriginalWorker {
  /**
   * Start the debugger through the benchmark wrapper that disables exporter I/O
   * and optionally records completed payloads.
   *
   * @param {string} filename
   * @param {import('node:worker_threads').WorkerOptions} options
   */
  constructor (filename, options) {
    assert.equal(filename, require.resolve('../../../packages/dd-trace/src/debugger/devtools_client'))
    super(require.resolve('./benchmark-worker'), {
      ...options,
      workerData: { ...options.workerData, probeCountBuffer },
    })
  }
}

const agentInfoPath = require.resolve('../../../packages/dd-trace/src/agent/info')
require.cache[agentInfoPath] = { exports: { fetchAgentInfo } }

// The benchmark has no active trace, so provide the production no-op tracer for
// the paused-frame expression without loading the debugger before its worker is replaced.
globalThis._ddtrace ??= new NoopTracer()

// Entry point normally primes this; bench imports src directly.
globalThis[Symbol.for('dd-trace')] ??= { beforeExitHandlers: new Set() }

const globalSnapshotCap = process.env.MAX_SNAPSHOTS_PER_SECOND_GLOBALLY
if (globalSnapshotCap) {
  const cap = Number(globalSnapshotCap)
  assert(Number.isInteger(cap) && cap > 0, 'MAX_SNAPSHOTS_PER_SECOND_GLOBALLY must be a positive integer')

  // The application-thread sampler loads this value after the override, then passes accepted probe indexes to the
  // debugger worker through shared memory.
  require('../../../packages/dd-trace/src/debugger/devtools_client/defaults').MAX_SNAPSHOTS_PER_SECOND_GLOBALLY = cap
}

const { start, stop } = loadDebugger()

const sourceFile = process.env.BREAKPOINT_FILE
const line = Number(process.env.BREAKPOINT_LINE)
assert(sourceFile, 'BREAKPOINT_FILE environment variable must be set')
assert(!Number.isNaN(line), 'BREAKPOINT_LINE environment variable must be a number')
const expectedBreakpoint = TRACK_PROBE_OUTPUT
  ? 'data.n = n // BREAKPOINT HERE!'
  : 'return n // BREAKPOINT HERE!'
assert.equal(
  fs.readFileSync(sourceFile, 'utf8').split('\n')[line - 1]?.trim(),
  expectedBreakpoint,
  `BREAKPOINT_LINE must point at "${expectedBreakpoint}"`
)

const breakpoint = { sourceFile, line }
// WARNING: Keep this fixture aligned with dd-trace's default config, apart from benchmark-specific overrides.
const config = {
  DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED: false,
  DD_TRACE_GIT_METADATA_ENABLED: false,
  debug: false,
  dynamicInstrumentation: {
    captureTimeoutMs: Number(process.env.DD_DYNAMIC_INSTRUMENTATION_CAPTURE_TIMEOUT_MS || '1000'),
    enabled: true,
    probeFile: undefined,
    redactedIdentifiers: [],
    redactionExcludedIdentifiers: [],
    uploadIntervalSeconds: 1,
  },
  env: undefined,
  hostname: 'debugger-benchmark',
  logLevel: 'error',
  port: 8126,
  service: 'debugger-benchmark',
  tags: { 'runtime-id': 'debugger-benchmark' },
  url: new URL('http://127.0.0.1:8126'),
  version: undefined,
}

/**
 * Resolve the production debugger endpoint without querying an external agent.
 *
 * @param {URL} url
 * @param {(error: Error | null, info: { endpoints: string[] }) => void} callback
 * @returns {void}
 */
function fetchAgentInfo (url, callback) {
  process.nextTick(callback, null, { endpoints: [DEBUGGER_INPUT_V2] })
}

/**
 * Load the production debugger with its worker constructor replaced only for
 * this benchmark process.
 *
 * @returns {typeof import('../../../packages/dd-trace/src/debugger')}
 */
function loadDebugger () {
  workerThreads.Worker = BenchmarkWorker
  try {
    return require('../../../packages/dd-trace/src/debugger')
  } finally {
    workerThreads.Worker = OriginalWorker
  }
}

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
 * Install the Dynamic Instrumentation probe and run `onProbeInstalled` once the
 * breakpoint is live. The ack fires only after `Debugger.setBreakpoint` resolves,
 * so the caller runs against an installed breakpoint instead of racing it.
 *
 * @param {() => void} onProbeInstalled
 */
function startDebugger (onProbeInstalled) {
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
        // Accept every hit instead of letting the real-time per-probe limiter vary
        // the amount of captured work.
        sampling: { snapshotsPerSecond: 1e10 },
      })
      cb(action, conf, 'id', (error) => {
        if (error) throw error
        onProbeInstalled()
      })
    },
    removeProductHandler () {},
  }

  start(config, rc)

  assert.ok(globalThis[Symbol.for('dd-trace')].utilTypes, 'debugger.start did not populate utilTypes')
}

module.exports = { probeCounts, start: startDebugger, stop }
