'use strict'

const dc = require('dc-polyfill')

const log = require('./log')

const configUpdateChannel = dc.channel('datadog:config:update')

/** @type {import('./profiling/ssi-heuristics').SSIHeuristics | undefined} */
let activeSSIHeuristics

/** @type {import('./profiling') | undefined} */
let profilingModule

function getProfilingModule () {
  profilingModule ??= require('./profiling')
  return profilingModule
}

// The profiling engine can stop itself (e.g. a collection error) without going through stop(), so
// read its state directly rather than caching a flag that could drift out of sync. Checking
// `profilingModule` first avoids forcing the profiling engine (and its native crashtracker binding)
// to load just to read this.
function isStarted () {
  return profilingModule !== undefined && profilingModule.profiler.enabled
}

/** @type {typeof import('./profiling/ssi-heuristics') | undefined} */
let ssiHeuristicsModule

function getSSIHeuristicsModule () {
  ssiHeuristicsModule ??= require('./profiling/ssi-heuristics')
  return ssiHeuristicsModule
}

function disableSSIHeuristics () {
  if (!activeSSIHeuristics) return
  activeSSIHeuristics.disable()
  activeSSIHeuristics = undefined
}

/**
 * @param {import('./config/config-base')} config - Tracer configuration
 */
function start (config) {
  try {
    // Forward the full tracer config to the profiling layer.
    // Profiling code is responsible for deriving the specific options it needs.
    return getProfilingModule().profiler.start(config)
  } catch (error) {
    log.error(
      'Error starting profiler. For troubleshooting tips, see <https://dtdg.co/nodejs-profiler-troubleshooting>',
      error
    )
    return false
  }
}

function stop () {
  // A stop command for a profiler that has never been loaded is already satisfied. Once loaded,
  // always forward it so the profiling layer can also cancel a restart queued during shutdown.
  if (profilingModule === undefined) return

  try {
    profilingModule.profiler.stop()
  } catch (error) {
    log.error(
      'Error stopping profiler. For troubleshooting tips, see <https://dtdg.co/nodejs-profiler-troubleshooting>',
      error
    )
  }
}

function cancelQueuedStart () {
  profilingModule?.profiler.cancelQueuedStart()
}

/**
 * @param {'true' | 'auto'} enabled - Profiling activation mode
 */
function hasQueuedStart (enabled) {
  return profilingModule?.profiler.hasQueuedStart(enabled) ?? false
}

/**
 * Declares the set of custom label keys that will be used with
 * `runWithLabels`.
 *
 * @param {Iterable<string>} keys - Custom label key names
 */
function setCustomLabelKeys (keys) {
  getProfilingModule().profiler.setCustomLabelKeys(keys)
}

/**
 * Runs a function with custom profiling labels attached to wall profiler samples.
 *
 * @param {Record<string, string | number>} labels - Custom labels to attach
 * @param {function(): T} fn - Function to execute with the labels
 * @returns {T} The return value of fn
 * @template T
 */
function runWithLabels (labels, fn) {
  return getProfilingModule().profiler.runWithLabels(labels, fn)
}

configUpdateChannel.subscribe((config) => {
  const enabled = config.profiling.DD_PROFILING_ENABLED
  if (enabled === 'true') {
    // A non-auto value means the SSI heuristics no longer get a say; disable them so a trigger that
    // fires after this publish can't start the profiler behind this decision's back.
    disableSSIHeuristics()
    // Leave an already-running profiler alone; otherwise an unrelated remote-config publish
    // (e.g. an unrelated sampling-rate change) would restart it on every update.
    if (!isStarted()) start(config)
  } else if (enabled === 'false') {
    disableSSIHeuristics()
    stop()
  } else if (enabled === 'auto') {
    if (!isStarted()) {
      // A completed SSI heuristic may have approved an auto start while shutdown is still in
      // flight. Preserve that decision across subsequent config publications.
      if (hasQueuedStart('auto')) return

      // Entering auto retracts any unconditional start queued by an earlier true update. Profiling
      // may start only if the active SSI heuristic makes that decision.
      cancelQueuedStart()
      if (activeSSIHeuristics) return

      // 'auto' defers the start decision to SSI heuristics. A running profiler already reflects a
      // decision that was made (by SSI or a prior unconditional enablement), so leave it alone
      // rather than stopping and re-enabling it on every subsequent config publication. Also guard
      // against creating another active instance; each SSIHeuristics instance owns listeners and a
      // timer until the heuristic makes its decision or is explicitly disabled.
      const { SSIHeuristics } = getSSIHeuristicsModule()
      const heuristics = new SSIHeuristics(config)
      activeSSIHeuristics = heuristics
      heuristics.start()
      heuristics.onTriggered(() => {
        // Explicit true/false publishes disable the heuristics, so reaching this callback guarantees
        // the latest valid published value is still 'auto'.
        if (!isStarted()) start(config)
        // The heuristic has made its decision, so release all of its listeners and timer before
        // dropping the module-level reference. This does not stop the profiler that was just
        // started; it only tears down the completed heuristic.
        heuristics.disable()
        if (activeSSIHeuristics === heuristics) activeSSIHeuristics = undefined
      })
    }
  } else {
    // Invalid config should preserve the last valid profiling decision, not accidentally behave
    // like 'auto' or crash the customer application.
    log.warn('Unexpected DD_PROFILING_ENABLED value: %o', enabled)
  }
})

globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(stop)

module.exports = { isStarted, start, stop, setCustomLabelKeys, runWithLabels }
