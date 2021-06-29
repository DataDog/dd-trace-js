'use strict'

const {
  profiler,
  CpuProfiler,
  HeapProfiler
} = require('../../../packages/dd-trace/src/profiling')

const { PROFILER } = process.env

const profilers = []

if (PROFILER === 'cpu' || PROFILER === 'all') {
  profilers.push(new CpuProfiler())
}
if (PROFILER === 'heap' || PROFILER === 'all') {
  profilers.push(new HeapProfiler())
}

const exporters = [{
  export () {
    profiler.stop()
    return Promise.resolve()
  }
}]

profiler.start({
  profilers,
  exporters,
  interval: 0
})

profiler._timer.ref()
