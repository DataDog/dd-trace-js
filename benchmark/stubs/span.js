'use strict'

const Uint64BE = require('int64-buffer').Uint64BE
const constants = require('../../src/constants')

const SAMPLE_RATE_METRIC_KEY = constants.SAMPLE_RATE_METRIC_KEY

const id = new Uint64BE(0x12345678, 0x12345678)

const span = {
  tracer: () => ({
    _service: 'service'
  }),
  addTags: () => {},
  context: () => ({
    traceId: id,
    spanId: id,
    parentId: id,
    trace: {
      started: [span, span],
      finished: [span, span]
    },
    tags: {
      resource: '/resource',
      type: 'web',
      error: true
    },
    metrics: {
      [SAMPLE_RATE_METRIC_KEY]: 1
    },
    sampled: true,
    sampling: {},
    name: 'operation'
  }),
  _startTime: 1500000000000.123456,
  _duration: 100
}

module.exports = span
