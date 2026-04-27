'use strict'

const path = require('node:path')
const { fileURLToPath } = require('node:url')

const log = require('../../log')

/**
 * Minimal V8-based code coverage collector used for Test Impact Analysis (ITR).
 *
 * ITR only needs to know whether any code in a given file was executed during
 * a suite run. Per-line granularity is not required. This collector relies on
 * `node:inspector` `Profiler.startPreciseCoverage` and takes diff snapshots
 * between suites to return the list of files that were touched.
 *
 * Start/stop is controlled by the framework instrumentation: it should only
 * run once the backend library configuration confirms that TIA/code coverage
 * is enabled, and must never run concurrently with `nyc` (detected via
 * `global.__coverage__`), which owns the same counters via istanbul.
 */
class V8CoverageCollector {
  #session
  #enabled = false
  #previousCounts = new Map()
  #cwd

  constructor ({ cwd } = {}) {
    this.#cwd = cwd || process.cwd()
  }

  isEnabled () {
    return this.#enabled
  }

  start () {
    if (this.#enabled) return true
    let inspector
    try {
      inspector = require('node:inspector')
    } catch (err) {
      log.warn('Could not load node:inspector for code coverage: %s', err?.message)
      return false
    }
    try {
      this.#session = new inspector.Session()
      this.#session.connect()
      this.#session.post('Profiler.enable')
      this.#session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false })
      this.#enabled = true
      return true
    } catch (err) {
      log.warn('Could not start V8 precise coverage: %s', err?.message)
      this.#enabled = false
      return false
    }
  }

  stop () {
    if (!this.#enabled) return
    try {
      this.#session.post('Profiler.stopPreciseCoverage')
      this.#session.disconnect()
    } catch {
      // ignore
    }
    this.#enabled = false
    this.#previousCounts.clear()
  }

  /**
   * Take a coverage snapshot and return the list of absolute file paths that
   * had any block executed since the last snapshot.
   *
   * @returns {string[]} Absolute filenames whose execution count increased
   *   since the previous call.
   */
  getFilesCoveredSinceLastSnapshot () {
    if (!this.#enabled) return []

    let scriptCoverages
    try {
      // In an in-process inspector session, the callback runs synchronously.
      this.#session.post('Profiler.takePreciseCoverage', (err, params) => {
        if (!err) scriptCoverages = params.result
      })
    } catch (err) {
      log.warn('Could not take V8 precise coverage snapshot: %s', err?.message)
      return []
    }

    if (!scriptCoverages) return []

    const changed = []
    for (const script of scriptCoverages) {
      const filename = scriptUrlToFilename(script.url)
      if (!filename) continue
      if (!isUserSource(filename, this.#cwd)) continue

      let sum = 0
      for (const func of script.functions) {
        for (const range of func.ranges) sum += range.count
      }

      const previous = this.#previousCounts.get(script.url) || 0
      if (sum > previous) changed.push(filename)
      this.#previousCounts.set(script.url, sum)
    }
    return changed
  }

  /**
   * Reset the baseline so the next `getFilesCoveredSinceLastSnapshot()` call
   * reflects only what changed since this point. Use this right before the
   * first suite runs so preceding module-load coverage does not leak into
   * the first suite's report.
   */
  resetBaseline () {
    if (!this.#enabled) return
    this.getFilesCoveredSinceLastSnapshot()
  }
}

function scriptUrlToFilename (url) {
  if (!url) return null
  if (url.startsWith('file://')) {
    try {
      return fileURLToPath(url)
    } catch {
      return null
    }
  }
  if (path.isAbsolute(url)) return url
  return null
}

function isUserSource (filename, cwd) {
  if (!filename.startsWith(cwd + path.sep) && filename !== cwd) return false
  if (filename.includes(`${path.sep}node_modules${path.sep}`)) return false
  // Skip dd-trace's own source whether it's developed in-tree or installed
  // as a dependency (the node_modules filter above already covers the
  // installed case, but guard dev checkouts too).
  if (filename.includes(`${path.sep}packages${path.sep}dd-trace${path.sep}`)) return false
  if (filename.includes(`${path.sep}packages${path.sep}datadog-`)) return false
  return true
}

let singleton = null

/**
 * Return true if an nyc/istanbul coverage engine is already running in this
 * process. We detect it via `global.__coverage__`, which nyc sets as soon as
 * the first instrumented module loads.
 *
 * V8 precise coverage can safely run in parallel with istanbul: istanbul
 * uses source-level instrumentation (counters in `global.__coverage__`),
 * while V8 tracks block execution at the engine level via `node:inspector`.
 * They do not share state. We expose this detection helper for callers that
 * want to keep V8 off when nyc is already providing an equivalent feed, but
 * it is not a precondition for starting.
 *
 * @returns {boolean}
 */
function isIstanbulCoverageActive () {
  return typeof globalThis.__coverage__ === 'object' && globalThis.__coverage__ !== null
}

/**
 * Lazily start a process-wide V8 coverage collector. Subsequent calls return
 * the same instance. Safe to run in parallel with nyc/istanbul.
 *
 * @param {{ cwd?: string }} [options]
 * @returns {V8CoverageCollector | null}
 */
function startV8Coverage (options) {
  if (singleton) return singleton
  const collector = new V8CoverageCollector({ cwd: options?.cwd || process.cwd() })
  if (!collector.start()) return null
  singleton = collector
  return collector
}

function getV8CoverageCollector () {
  return singleton
}

function stopV8Coverage () {
  if (!singleton) return
  singleton.stop()
  singleton = null
}

module.exports = {
  V8CoverageCollector,
  startV8Coverage,
  getV8CoverageCollector,
  stopV8Coverage,
  isIstanbulCoverageActive,
}
