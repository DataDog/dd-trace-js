'use strict'

const { mkdirSync } = require('node:fs')
const path = require('node:path')

const preloadList = require('node-preload')

const { installPatch } = require('./patch-child-process')
const {
  DISABLE_ENV,
  FLUSH_SIGNAL_KEY,
  ROOT_ENV,
  canonicalizePath,
  isCoverageActive,
  isPreInstrumentedSandbox,
  prependBootstrapRequire,
  resolveCoverageRoot,
} = require('./runtime')

const BOOTSTRAPPED = Symbol.for('dd-trace.integration-coverage.bootstrapped')
const OWN_TEMPDIR_MARKER = `${path.sep}.nyc_output${path.sep}integration-tests`

/** @typedef {{ unrefCounted?: () => void } | null | undefined} RefCountedChannel */

if (isCoverageActive() && !process.env[DISABLE_ENV] && !globalThis[BOOTSTRAPPED]) {
  globalThis[BOOTSTRAPPED] = true
  bootstrapCoverage()
}

function hasForeignNyc () {
  const config = process.env.NYC_CONFIG
  if (!config) return false
  try {
    const parsed = JSON.parse(config)
    return typeof parsed.tempDir !== 'string' || !parsed.tempDir.includes(OWN_TEMPDIR_MARKER)
  } catch {
    return true
  }
}

function bootstrapCoverage () {
  const coverageRoot = resolveCoverageRoot({ cwd: process.env[ROOT_ENV] || process.cwd() })
  if (!coverageRoot) return

  const preInstrumented = isPreInstrumentedSandbox(coverageRoot)
  const foreignNyc = hasForeignNyc()

  // A foreign nyc (spawned by a test like cucumber.spec's `nyc --all ...`) drives its own
  // coverage collection. Pre-instrumented dd-trace counters still pollute `global.__coverage__`
  // though, which skews `nyc --all` style reporters. Install the enumeration shield so those
  // entries stay invisible to any enumeration-based consumer, and leave the rest of the harness
  // (writer, nyc.wrap) alone.
  // TODO(BridgeAR): also install the pre-instrumented writer here, filtered to the
  // `PRE_INSTRUMENTED_ROOT`-keyed entries so the foreign nyc keeps owning the rest. As of
  // today the dd-trace counters accumulated under cucumber's `nyc --all` are dropped on the
  // floor, so the cucumber suite under-reports coverage for dd-trace itself.
  if (foreignNyc) {
    if (preInstrumented) {
      const { installCoverageShield } = require('./pre-instrumented-writer')
      installCoverageShield()
    }
    return
  }

  process.env[ROOT_ENV] = canonicalizePath(coverageRoot)
  process.env.NODE_OPTIONS = prependBootstrapRequire(process.env.NODE_OPTIONS)
  if (!preloadList.includes(__filename)) preloadList.push(__filename)

  if (preInstrumented) {
    const { installPreInstrumentedWriter } = require('./pre-instrumented-writer')
    installPreInstrumentedWriter(coverageRoot)
  } else {
    installRuntimeInstrumentation(coverageRoot)
  }

  // Patch this descendant's `child_process` and `worker_threads` so its grandchildren
  // also pick up the bootstrap, even when the caller passes an explicit `env`.
  installPatch()
  maybePatchWindowsFlush()
}

/**
 * @param {string} coverageRoot
 * @returns {void}
 */
function installRuntimeInstrumentation (coverageRoot) {
  const NYC = require('nyc')
  const { createConfig } = require('./nyc.sandbox.config')
  const config = { ...createConfig(coverageRoot), cwd: coverageRoot }

  const nyc = new NYC({
    ...config,
    isChildProcess: Boolean(process.env.NYC_PROCESS_ID),
    _processInfo: {
      pid: process.pid,
      ppid: process.ppid,
      parent: process.env.NYC_PROCESS_ID || null,
    },
  })

  mkdirSync(nyc.tempDirectory(), { recursive: true })
  mkdirSync(nyc.processInfo.directory, { recursive: true })

  process.env.NYC_CONFIG = JSON.stringify(config)

  const registerEnvPath = require.resolve('nyc/lib/register-env.js')
  if (!preloadList.includes(registerEnvPath)) preloadList.push(registerEnvPath)
  require(registerEnvPath)('NYC_PROCESS_ID')
  nyc.wrap()
}

/**
 * Windows `SIGTERM` is forceful and skips our exit hook; flush on the IPC sentinel from
 * `helpers#stopProc` instead. `unrefCounted` lets the listener not keep idle fixtures alive.
 *
 * @returns {void}
 */
function maybePatchWindowsFlush () {
  if (process.platform !== 'win32') return
  process.on('message', message => {
    if (message?.[FLUSH_SIGNAL_KEY] === true) {
      process.exit(0)
    }
  })
  const channel = /** @type {RefCountedChannel} */ (/** @type {unknown} */ (process.channel))
  channel?.unrefCounted?.()
}
