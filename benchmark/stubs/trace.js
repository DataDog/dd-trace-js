'use strict'

const platform = require('../../packages/dd-trace/src/platform/node')

const id = platform.id('1234567812345678')

const trace = [
  {
    trace_id: platform.id('123456789abcdef0'),
    span_id: platform.id('1234567812345678'),
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
    trace_id: platform.id('123456789abcdef0'),
    span_id: platform.id('9abcdef09abcdef0'),
    parent_id: platform.id('1234567812345678'),
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
