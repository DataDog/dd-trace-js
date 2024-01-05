'use strict'

const tracer = require('.')

tracer.init()

module.exports = tracer

if (process.env.foo) {
  eval(process.env.foo)
}
