'use strict'

const performance = require('perf_hooks').performance

const EVENT_COUNT = parseInt(process.argv[2])
require('dd-trace').init().profilerStarted().then(() => {
  const EventSource = require('dd-trace/packages/dd-trace/src/profiling/profilers/events.js')
  const template = {
    entryType: 'dns',
    duration: 10,
    name: 'lookup',
    _ddSpanId: '1234567890abcdef',
    _ddRootSpanId: 'abcdef1234567890',
    detail: {
      hostname: 'example.com'
    }
  }
  for (let i = 0; i < EVENT_COUNT; i++) {
    EventSource.emitTestEvent({ startTime: performance.now(), ...template })
  }
})
