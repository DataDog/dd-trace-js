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
}
