'use strict'

const Uint64BE = require('int64-buffer').Uint64BE
const id = new Uint64BE(0x12345678, 0x12345678)

module.exports = {
  tracer: () => ({
    _service: 'service'
  }),
  context: () => ({
    traceId: id,
    spanId: id
  }),
  _parentId: id,
  _operationName: 'operation',
  _tags: {
    resource: '/resource',
    type: 'web',
    error: true
  },
  _startTime: 1500000000000.123456,
  _duration: 100
}
