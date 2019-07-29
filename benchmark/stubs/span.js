'use strict'

const platform = require('../../packages/dd-trace/src/platform/node')
const constants = require('../../packages/dd-trace/src/constants')

const SAMPLE_RATE_METRIC_KEY = constants.SAMPLE_RATE_METRIC_KEY

const id = platform.id('1234567812345678')

const span = {
  tracer: () => ({
    scope: () => ({
      _wipe: () => {}
    }),
    _service: 'service'
  }),
  addTags: () => {},
  context: () => ({
    _traceId: id,
    _spanId: id,
    _parentId: id,
    _trace: {
      started: [span, span],
      finished: [span, span]
    },
    _tags: {
      resource: '/resource',
      type: 'web',
      error: true
    },
    _metrics: {
      [SAMPLE_RATE_METRIC_KEY]: 1
    },
    _sampling: {},
    _traceFlags: {},
    _name: 'operation'
  }),
  _startTime: 1500000000000.123456,
  _duration: 100
}

module.exports = span
