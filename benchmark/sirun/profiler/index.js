'use strict'

const {
  profiler,
} = require('../../../packages/dd-trace/src/profiling')

const { PROFILER } = process.env

const profilers = []

if (PROFILER === 'wall' || PROFILER === 'all') {
  profilers.push('wall')
}
if (PROFILER === 'space' || PROFILER === 'all') {
  profilers.push('space')
}

const exporters = ['none']

profiler.start(/** @type {import('../../../packages/dd-trace/src/config/config-base')} */ ({
  DD_PROFILING_PROFILERS: profilers,
  DD_PROFILING_EXPORTERS: exporters,
  DD_PROFILING_HEAP_SAMPLING_INTERVAL: 0,
}))
