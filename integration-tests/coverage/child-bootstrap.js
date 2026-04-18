'use strict'

const { mkdirSync } = require('node:fs')
const path = require('node:path')

const NYC = require('nyc')
const preloadList = require('node-preload')

const {
  DISABLE_ENV,
  FLUSH_SIGNAL_KEY,
  ROOT_ENV,
  canonicalizePath,
  isCoverageActive,
  prependBootstrapRequire,
  resolveCoverageRoot,
} = require('./runtime')

const BOOTSTRAPPED = Symbol.for('dd-trace.integration-coverage.bootstrapped')
// Our NYC tempDirs live under this segment. An inherited NYC_CONFIG pointing elsewhere means
// an external NYC owns the tree — bail out.
const OWN_TEMPDIR_MARKER = `${path.sep}.nyc_output${path.sep}integration-tests`

/** @typedef {{ unrefCounted?: () => void } | null | undefined} RefCountedChannel */

if (isCoverageActive() && !process.env[DISABLE_ENV] && !globalThis[BOOTSTRAPPED]) {
  globalThis[BOOTSTRAPPED] = true
  if (!hasForeignNyc()) bootstrapCoverage()
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

  process.env[ROOT_ENV] = canonicalizePath(coverageRoot)
  process.env.NYC_CONFIG = JSON.stringify(config)
  process.env.NODE_OPTIONS = prependBootstrapRequire(process.env.NODE_OPTIONS)

  // Propagate NYC's env registration and this bootstrap into every grandchild Node process.
  const registerEnvPath = require.resolve('nyc/lib/register-env.js')
  if (!preloadList.includes(registerEnvPath)) preloadList.push(registerEnvPath)
  if (!preloadList.includes(__filename)) preloadList.push(__filename)

  require(registerEnvPath)('NYC_PROCESS_ID')
  nyc.wrap()

  // Windows only: `proc.kill('SIGTERM')` is forceful and skips nyc's exit hook, so flush on an
  // explicit IPC sentinel from `helpers#stopProc`. `unrefCounted` decrements Node's internal
  // listener ref so our handler doesn't keep otherwise-idle fixtures alive while still allowing
  // user-code listeners to re-ref the channel normally. POSIX omits this entirely.
  if (process.platform === 'win32') {
    process.on('message', message => {
      if (message?.[FLUSH_SIGNAL_KEY] === true) {
        process.exit(0)
      }
    })
    const channel = /** @type {RefCountedChannel} */ (/** @type {unknown} */ (process.channel))
    channel?.unrefCounted?.()
  }
}
