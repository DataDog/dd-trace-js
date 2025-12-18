'use strict'

const Module = require('node:module')
const path = require('node:path')

const sinon = require('sinon')

const repoRoot = path.resolve(__dirname, '../../../..')
const selfPath = __filename

// Snapshot the initial environment so we can restore between test files when using Mocha's worker pool.
const initialEnv = { ...process.env }

function resetOpenTelemetryGlobals () {
  // OpenTelemetry stores global state under a versioned symbol key. When Mocha's worker pool
  // reuses processes across spec files, we need to clear this state to avoid cross-file leakage.
  for (const major of ['1', '0']) {
    try {
      delete globalThis[Symbol.for(`opentelemetry.js.api.${major}`)]
    } catch {
      // ignore
    }
  }
}

function restoreEnv () {
  for (const key of Object.keys(process.env)) {
    if (!(key in initialEnv)) {
      delete process.env[key]
    }
  }

  for (const [key, value] of Object.entries(initialEnv)) {
    process.env[key] = value
  }

  // `node-gyp-build` treats this as an Electron runtime signal and will look for Electron prebuilds.
  // Ensure we run as plain Node for unit tests.
  delete process.env.ELECTRON_RUN_AS_NODE
}

function clearRepoRequireCache () {
  for (const key of Object.keys(require.cache)) {
    if (key === selfPath) continue
    if (!key.startsWith(repoRoot)) continue
    if (key.includes(`${path.sep}node_modules${path.sep}`)) continue
    delete require.cache[key]
  }
}

function resetBetweenFiles () {
  // Restore any leaked stubs from previous files in the worker process.
  try {
    sinon.restore()
  } catch {
    // ignore
  }

  resetOpenTelemetryGlobals()

  // dd-trace stores a singleton on the global object. Ensure each spec file starts clean,
  // similar to tap's process-per-file execution.
  try {
    global._ddtrace?._pluginManager?.destroy()
  } catch {
    // ignore
  }
  delete global._ddtrace

  restoreEnv()
  clearRepoRequireCache()
}

// @ts-expect-error - private Node.js API used for test isolation between spec files
const originalLoad = Module._load
// @ts-expect-error - private Node.js API used for test isolation between spec files
Module._load = function (request, parent, isMain) {
  // Resolve filename first so we can identify spec files reliably.
  // @ts-expect-error - private Node.js API used for test isolation between spec files
  const filename = Module._resolveFilename(request, parent, isMain)

  if (typeof filename === 'string' && filename.endsWith('.spec.js')) {
    resetBetweenFiles()
  }

  return originalLoad.apply(this, arguments)
}
