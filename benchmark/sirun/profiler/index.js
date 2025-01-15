'use strict'

const {
  profiler,
  WallProfiler,
  SpaceProfiler
} = require('../../../packages/dd-trace/src/profiling')

const { PROFILER } = process.env

const profilers = []

if (PROFILER === 'wall' || PROFILER === 'all') {
  profilers.push(new WallProfiler())
}
if (PROFILER === 'space' || PROFILER === 'all') {
  profilers.push(new SpaceProfiler())
}

if (profilers.length === 0) {
  // Add a no-op "profiler"
  profilers.push({
    start: () => {},
    stop: () => {},
    profile: () => { return true },
    encode: () => { Promise.resolve(true) }
  })
}

const exporters = [{
  export () {
    profiler.stop()
    return Promise.resolve()
  }
}]

profiler._start({
  profilers,
  exporters,
  interval: 0
}).then(() => {
  profiler._timer.ref()
})
