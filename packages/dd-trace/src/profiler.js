'use strict'

const dc = require('../../../vendor/dist/dc-polyfill')

const log = require('./log')

const configUpdateChannel = dc.channel('datadog:config:update')

/** @type {import('./profiling/ssi-heuristics').SSIHeuristics | undefined} */
let activeSSIHeuristics

/** @type {import('./profiling') | undefined} */
let profilingModule

/**
 * Configuration published while the profiler was finishing a shutdown export, waiting for that
 * export to settle before it is acted on.
 *
 * @type {import('./config/config-base') | undefined}
 */
let deferredConfig

function getProfilingModule () {
  if (profilingModule === undefined) {
    profilingModule = require('./profiling')
    // The profiling layer never restarts itself; it only reports that a shutdown export has
    // settled, which is when a configuration deferred during that window gets its decision.
    profilingModule.profiler.on('stopped', applyDeferredConfig)
  }
  return profilingModule
}

// The profiling engine can stop itself (e.g. a collection error) without going through stop(), so
// read its state directly rather than caching a flag that could drift out of sync. Checking
// `profilingModule` first avoids forcing the profiling engine (and its native crashtracker binding)
// to load just to read this.
function isStarted () {
  return profilingModule !== undefined && profilingModule.profiler.enabled
}

// A stopped profiler still exports one final profile, and until that settles it reports neither
// the state a decision would be based on nor any willingness to start again.
function isStopping () {
  return profilingModule !== undefined && profilingModule.profiler.isStopping()
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
  // An explicit stop is the latest desired state, so it retracts a configuration still waiting
  // for an in-flight shutdown to settle.
  deferredConfig = undefined

  // A stop command for a profiler that has never been loaded is already satisfied.
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

function applyDeferredConfig () {
  const config = deferredConfig
  if (config === undefined) return
  deferredConfig = undefined
  applyConfig(config)
}

/**
 * @param {import('./config/config-base')} config - Tracer configuration
 */
function applyConfig (config) {
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
    if (!isStarted() && !activeSSIHeuristics) {
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
        // the latest valid published value is still 'auto'. A heuristic is only ever created for a
        // profiler that is neither running nor stopping, and nothing can start that profiler behind
        // an active heuristic's back, so this start can not collide with a shutdown in flight.
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
}

configUpdateChannel.subscribe((config) => {
  // A shutdown export in flight makes every decision here unsafe: the profiler can not be
  // started, and it does not yet report the state the auto branch would branch on. Defer instead,
  // keeping only the latest configuration, exactly as a sequence of updates outside such a window
  // would have left it.
  if (isStopping()) {
    deferredConfig = config
    return
  }
  applyConfig(config)
})

globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(stop)

module.exports = { isStarted, start, stop, setCustomLabelKeys, runWithLabels }
