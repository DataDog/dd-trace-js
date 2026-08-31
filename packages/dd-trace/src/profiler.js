'use strict'

const dc = require('dc-polyfill')

const log = require('./log')

const configUpdateChannel = dc.channel('datadog:config:update')

/** @type {boolean} */
module.started = false

/** @type {import('./profiling/ssi-heuristics').SSIHeuristics | undefined} */
let armedSSIHeuristics

/** @type {import('./profiling') | undefined} */
let profilingModule

function getProfilingModule () {
  profilingModule ??= require('./profiling')
  return profilingModule
}

/** @type {typeof import('./profiling/ssi-heuristics') | undefined} */
let ssiHeuristicsModule

function getSSIHeuristicsModule () {
  ssiHeuristicsModule ??= require('./profiling/ssi-heuristics')
  return ssiHeuristicsModule
}

function disarmSSIHeuristics () {
  if (!armedSSIHeuristics) return
  armedSSIHeuristics.onTriggered() // deregister this callback
  armedSSIHeuristics = undefined
}

/**
 * @param {import('./config/config-base')} config - Tracer configuration
 * @returns {boolean} whether the profiler is running after this call
 */
module.start = function (config) {
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

module.stop = function () {
  try {
    getProfilingModule().profiler.stop()
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
module.setCustomLabelKeys = function (keys) {
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
module.runWithLabels = function (labels, fn) {
  return getProfilingModule().profiler.runWithLabels(labels, fn)
}

configUpdateChannel.subscribe((config) => {
  const enabled = config.profiling.DD_PROFILING_ENABLED
  if (enabled === 'true') {
    // A non-auto value means the SSI heuristics no longer get a say; disarm so a trigger that
    // fires after this publish can't start the profiler behind this decision's back.
    disarmSSIHeuristics()
    // Leave an already-running profiler alone; otherwise an unrelated remote-config publish
    // (e.g. an unrelated sampling-rate change) would restart it on every update.
    if (!module.started) module.started = module.start(config)
  } else if (enabled === 'false') {
    disarmSSIHeuristics()
    // Only touch the profiling layer if it was actually running, so a disabled profiler never
    // forces the profiling engine (and its native crashtracker binding) to load.
    if (module.started) module.stop()
    module.started = false
  } else if (!module.started && !armedSSIHeuristics) {
    // 'auto' defers the start decision to SSI heuristics. A running profiler already reflects a
    // decision that was made (by SSI or a prior unconditional enablement), so leave it alone
    // rather than stopping and re-arming it on every subsequent config publication. Also guard
    // against re-arming while already armed; each SSIHeuristics instance registers its own
    // listeners/timer that are only torn down on trigger.
    const { SSIHeuristics } = getSSIHeuristicsModule()
    armedSSIHeuristics = new SSIHeuristics(config)
    armedSSIHeuristics.start()
    armedSSIHeuristics.onTriggered(() => {
      // Since disarmSSIHeuristics() runs on every non-auto publish, reaching this callback
      // guarantees the latest published value is still 'auto'.
      if (!module.started) module.started = module.start(config)
      disarmSSIHeuristics()
    })
  }
})

globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(() => { if (module.started) module.stop() })

module.exports = module
