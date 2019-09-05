'use strict'

const id = require('../../packages/dd-trace/src/id')

const trace = [
  {
    trace_id: id('123456789abcdef0'),
    span_id: id('1234567812345678'),
    parent_id: null,
    name: 'root',
    resource: '/',
    service: 'benchmark',
    type: 'web',
    error: 0,
    meta: {},
    metrics: {},
    start: 1500000000000123600,
    duration: 100000000
  },
  {
    trace_id: id('123456789abcdef0'),
    span_id: id('9abcdef09abcdef0'),
    parent_id: id('1234567812345678'),
    name: 'child',
    resource: '/',
    service: 'benchmark',
    type: 'web',
    error: 0,
    meta: {},
    metrics: {},
    start: 1500000000000123600,
    duration: 80000000
  }
]

module.exports = trace
