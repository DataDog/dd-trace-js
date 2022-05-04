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
