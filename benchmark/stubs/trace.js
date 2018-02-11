'use strict'

const Uint64BE = require('int64-buffer').Uint64BE
const Buffer = require('safe-buffer').Buffer

const trace = [
  {
    trace_id: new Uint64BE(Buffer.alloc(8), 0x01),
    span_id: new Uint64BE(Buffer.alloc(8), 0x01),
    parent_id: null,
    name: 'root',
    resource: '/',
    service: 'benchmark',
    type: 'web',
    error: 0,
    meta: {
      foo: 'bar',
      bar: 'baz',
      baz: 'qux',
      qux: 'quxx'
    },
    start: 1500000000000123600,
    duration: 100000000
  },
  {
    trace_id: new Uint64BE(Buffer.alloc(8), 0x01),
    span_id: new Uint64BE(Buffer.alloc(8), 0x02),
    parent_id: new Uint64BE(Buffer.alloc(8), 0x01),
    name: 'child',
    resource: '/',
    service: 'benchmark',
    type: 'web',
    error: 0,
    meta: {
      foo: 'bar',
      bar: 'baz',
      baz: 'qux',
      qux: 'quxx'
    },
    start: 1500000000000123600,
    duration: 80000000
  }
]

module.exports = trace
