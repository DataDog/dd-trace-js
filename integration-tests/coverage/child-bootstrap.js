'use strict'

const { mkdirSync } = require('node:fs')
const path = require('node:path')

const NYC = require('nyc')
const preloadList = require('node-preload')

const {
  ROOT_ENV,
  appendBootstrapRequire,
  canonicalizePath,
  isCoverageActive,
  resolveCoverageRoot,
} = require('./runtime')

const BOOTSTRAPPED = Symbol.for('dd-trace.integration-coverage.bootstrapped')
// Our NYC tempDirs always live under this path segment. If the inherited NYC_CONFIG points
// somewhere else, an external NYC already owns this process tree and we must not re-wrap.
const OWN_TEMPDIR_MARKER = `${path.sep}.nyc_output${path.sep}integration-tests`

if (isCoverageActive() && !globalThis[BOOTSTRAPPED]) {
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
  process.env.NYC_CWD = coverageRoot
  process.env.NODE_OPTIONS = appendBootstrapRequire(process.env.NODE_OPTIONS)

  // Re-preload NYC's env registration and this bootstrap in every grandchild Node process
  // so coverage keeps propagating down the tree (via node-preload's NODE_OPTIONS handling).
  const registerEnvPath = require.resolve('nyc/lib/register-env.js')
  if (!preloadList.includes(registerEnvPath)) preloadList.push(registerEnvPath)
  if (!preloadList.includes(__filename)) preloadList.push(__filename)

  require(registerEnvPath)('NYC_PROCESS_ID')
  nyc.wrap()
}
