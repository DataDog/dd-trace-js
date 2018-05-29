'use strict'

const Int64BE = require('int64-buffer').Int64BE
const id = new Int64BE(0x12345678, 0x12345678)

const span = {
  tracer: () => ({
    _service: 'service'
  }),
  context: () => ({
    traceId: id,
    spanId: id,
    parentId: id,
    trace: {
      started: [span, span],
      finished: [span, span]
    }
  }),
  _operationName: 'operation',
  _tags: {
    resource: '/resource',
    type: 'web',
    error: true
  },
  _startTime: 1500000000000.123456,
  _duration: 100
}

module.exports = span
