'use strict'

const { profiler } = require('./profiling')

// Stop profiler upon exit in order to collect and export the current profile
process.once('beforeExit', () => { profiler.stop() })

module.exports = {
  start: config => {
    // Forward the full tracer config to the profiling layer.
    // Profiling code is responsible for deriving the specific options it needs.
    return profiler.start(config)
  },

  stop: () => {
    profiler.stop()
  }
}
