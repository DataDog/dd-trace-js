'use strict'

const tracer = require('dd-trace')

tracer.init({
  flushInterval: 0,
})
