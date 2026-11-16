'use strict'

// Preloaded (via BUN_OPTIONS=--preload) into every Bun descendant of a `run-bun-suite.js` run.
//
// Bun runs on JavaScriptCore: it ignores NODE_V8_COVERAGE and NODE_OPTIONS, and the offsets its
// inspector reports point into Bun's own transpiled output rather than the file on disk. So instead
// of native V8 coverage, in-scope dd-trace sources are instrumented with istanbul (the instrumenter
// nyc uses) as they load, keyed at their repo path, and the counters are written into the collector
// on exit. merge-lcov.js folds them into the same report as the V8 profiles.

const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const Module = require('node:module')
const path = require('node:path')

const { createInstrumenter } = require('istanbul-lib-instrument')

const { rebaseSandboxPath, shouldInclude } = require('./merge-lcov')
const { DISABLE_ENV, getIstanbulCoverageDir, isCoverageActive } = require('./runtime')

const BOOTSTRAPPED = Symbol.for('dd-trace.integration-coverage.bun-bootstrapped')
const COVERAGE_VARIABLE = '__coverage__'
// Bun's CommonJS `onLoad` results lose `module.exports`, so plugins only take ES modules. dd-trace
// ships CommonJS as `.js` and ES modules as `.mjs`; nested dependencies are never in scope.
const ESM_FILTER = /[\\/]node_modules[\\/]dd-trace[\\/](?:(?!node_modules[\\/]).)*\.mjs$/

if (process.versions.bun && isCoverageActive() && !process.env[DISABLE_ENV] && !globalThis[BOOTSTRAPPED]) {
  globalThis[BOOTSTRAPPED] = true
  bootstrapCoverage()
}

function bootstrapCoverage () {
  const instrumenters = {
    commonjs: createInstrumenter({ coverageVariable: COVERAGE_VARIABLE, esModules: false }),
    module: createInstrumenter({ coverageVariable: COVERAGE_VARIABLE, esModules: true }),
  }

  /**
   * @param {string} filename
   * @param {'commonjs' | 'module'} format
   * @returns {string | undefined} instrumented source, or `undefined` when the file is out of scope
   */
  function instrument (filename, format) {
    const coveragePath = rebaseSandboxPath(filename)
    if (!shouldInclude(coveragePath)) return
    const source = readFileSync(filename, 'utf8')
    // Babel installs its own `Error.prepareStackTrace` on first use, and Bun's
    // `Error.captureStackTrace` then rejects the plain objects the tracer passes it.
    const { prepareStackTrace, stackTraceLimit } = Error
    try {
      return instrumenters[format].instrumentSync(source, coveragePath)
    } catch {
      return source
    } finally {
      Error.prepareStackTrace = prepareStackTrace
      Error.stackTraceLimit = stackTraceLimit
    }
  }

  // Bun never calls `Module.prototype._compile` on its own, but does dispatch `require()` through
  // `Module._extensions`, and compiles the source it is handed when `_compile` is called explicitly.
  const loadJs = Module._extensions['.js']
  Module._extensions['.js'] = function (module, filename) {
    const instrumented = instrument(filename, 'commonjs')
    if (instrumented === undefined) return loadJs.apply(this, arguments)
    Module.prototype._compile.call(module, instrumented, filename)
  }

  globalThis.Bun.plugin({
    name: 'dd-trace-integration-coverage',
    setup (build) {
      build.onLoad({ filter: ESM_FILTER }, ({ path: filename }) => {
        // Every matching `onLoad` callback has to return contents, including out-of-scope files.
        return { loader: 'js', contents: instrument(filename, 'module') ?? readFileSync(filename, 'utf8') }
      })
    },
  })

  installCoverageWrite()
}

/**
 * Write the istanbul counters on exit, and on the termination signals the harness uses to stop
 * long-running fixtures. Mirrors `child-bootstrap.js`: only force the exit when no other handler
 * for the signal exists, so a fixture with its own handler keeps control.
 */
function installCoverageWrite () {
  const outputDir = getIstanbulCoverageDir()
  const outputFile = path.join(outputDir, `bun-${process.pid}-${Date.now()}.json`)

  function writeCoverage () {
    const coverage = globalThis[COVERAGE_VARIABLE]
    if (!coverage) return
    try {
      mkdirSync(outputDir, { recursive: true })
      writeFileSync(outputFile, JSON.stringify(coverage))
    } catch {}
  }

  process.on('exit', writeCoverage)
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      writeCoverage()
      if (process.listenerCount(signal) === 0) {
        process.exit(0)
      }
    })
  }
}
