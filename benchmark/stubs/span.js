'use strict'

const constants = require('../../packages/dd-trace/src/constants')
const id = require('../../packages/dd-trace/src/id')

const SAMPLE_RATE_METRIC_KEY = constants.SAMPLE_RATE_METRIC_KEY

const spanId = id('1234567812345678')

const span = {
  tracer: () => ({
    scope: () => ({
      _wipe: () => {}
    }),
    _service: 'service'
  }),
  addTags: () => {},
  context: () => ({
    _traceId: spanId,
    _spanId: spanId,
    _parentId: spanId,
    _trace: {
      started: [span, span],
      finished: [span, span]
    },
    _tags: {
      resource: '/resource',
      type: 'web',
      error: true,
      [SAMPLE_RATE_METRIC_KEY]: 1
    },
    _sampling: {},
    _traceFlags: {},
    _name: 'operation'
  }),
  _startTime: 1500000000000.123456,
  _duration: 100,
  _spanContext: {
    _name: 'operation'
  }
}

module.exports = span
