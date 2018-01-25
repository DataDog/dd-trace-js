'use strict'

const Uint64BE = require('int64-buffer').Uint64BE

const trace = [
  {
    trace_id: new Uint64BE(0x12345678, 0x9abcdef0),
    span_id: new Uint64BE(0x12345678, 0x12345678),
    parent_id: null,
    name: 'root',
    resource: '/',
    service: 'benchmark',
    type: 'web',
    error: 0,
    meta: {},
    start: new Uint64BE(0x00001000, 0),
    duration: new Uint64BE(0, 100000000)
  },
  {
    trace_id: new Uint64BE(0x12345678, 0x9abcdef0),
    span_id: new Uint64BE(0x9abcdef0, 0x9abcdef0),
    parent_id: new Uint64BE(0x12345678, 0x12345678),
    name: 'child',
    resource: '/',
    service: 'benchmark',
    type: 'web',
    error: 0,
    meta: {},
    start: new Uint64BE(0x00001000, 0),
    duration: new Uint64BE(0, 100000000)
  }
]

module.exports = trace
