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
  getProfilingModule().profiler.stop()
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
  if (config.profiling.DD_PROFILING_ENABLED === 'true') {
    // Leave an already-running profiler alone; otherwise an unrelated remote-config publish
    // (e.g. an unrelated sampling-rate change) would restart it on every update.
    if (!module.started) module.started = module.start(config)
  } else {
    // Only touch the profiling layer if it was actually running, so a disabled profiler never
    // forces the profiling engine (and its native crashtracker binding) to load.
    if (module.started) module.stop()
    module.started = false

    // Guard against re-arming on every unrelated remote-config publish while still 'auto'; each
    // SSIHeuristics instance registers its own listeners/timer that are only torn down on trigger.
    if (config.profiling.DD_PROFILING_ENABLED === 'auto' && !armedSSIHeuristics) {
      const { SSIHeuristics } = getSSIHeuristicsModule()
      armedSSIHeuristics = new SSIHeuristics(config)
      armedSSIHeuristics.start()
      armedSSIHeuristics.onTriggered(() => {
        module.started = module.start(config)
        armedSSIHeuristics.onTriggered() // deregister this callback
        armedSSIHeuristics = undefined
      })
    }
  }
})

globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(() => { if (module.started) module.stop() })

module.exports = module
