'use strict'

const id = require('../../packages/dd-trace/src/id')

const spanId = id('1234567812345678')

const tags = {
  'resource.name': '/resource',
  'service.name': 'benchmark',
  'span.type': 'web',
  error: true
}

const span = {
  tracer: () => ({
    scope: () => ({
      _wipe: () => {}
    }),
    _service: 'service'
  }),
  addTags: () => {},
  _addTags: () => {},
  context: () => ({
    _traceId: spanId,
    _spanId: spanId,
    _parentId: spanId,
    _trace: {
      started: [span, span],
      finished: [span, span],
      tags
    },
    _tags: tags,
    _sampling: {},
    _name: 'operation'
  }),
  _startTime: 1500000000000.123,
  _duration: 100,
  _spanContext: {
    _name: 'operation'
  },
  setTag (key, value) {
    this._addTags({ [key]: value })
  }
}

module.exports = span
