'use strict'

const id = require('../../packages/dd-trace/src/id')

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
      'resource.name': '/resource',
      'service.name': 'benchmark',
      'span.type': 'web',
      error: true
    },
    _sampling: {},
    _name: 'operation'
  }),
  _startTime: 1500000000000.123,
  _duration: 100,
  _spanContext: {
    _name: 'operation'
  }
}

module.exports = span
