'use strict'

const { profiler } = require('./profiling')

globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(() => { profiler.stop() })

module.exports = {
  /**
   * @param {import('./config/config-base')} config - Tracer configuration
   */
  start (config) {
    // Forward the full tracer config to the profiling layer.
    // Profiling code is responsible for deriving the specific options it needs.
    return profiler.start(config)
  },

  stop () {
    profiler.stop()
  },

  /**
   * Declares the set of custom label keys that will be used with
   * {@link runWithLabels}.
   *
   * @param {Iterable<string>} keys - Custom label key names
   */
  setCustomLabelKeys: (keys) => {
    profiler.setCustomLabelKeys(keys)
  },

  /**
   * Runs a function with custom profiling labels attached to wall profiler samples.
   *
   * @param {Record<string, string | number>} labels - Custom labels to attach
   * @param {function(): T} fn - Function to execute with the labels
   * @returns {T} The return value of fn
   * @template T
   */
  runWithLabels: (labels, fn) => {
    return profiler.runWithLabels(labels, fn)
  },
}
