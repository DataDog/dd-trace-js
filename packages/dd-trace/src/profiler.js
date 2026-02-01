'use strict'

const { profiler } = require('./profiling')

globalThis[Symbol.for('dd-trace')].beforeExitHandlers.add(() => { profiler.stop() })

module.exports = {
  start: config => {
    // Forward the full tracer config to the profiling layer.
    // Profiling code is responsible for deriving the specific options it needs.
    return profiler.start(config)
  },

  stop: () => {
    profiler.stop()
  },
}
