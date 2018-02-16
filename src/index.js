'use strict'

const DatadogTracer = require('./opentracing/tracer')

module.exports = {
  init (config) {
    this.tracer = new DatadogTracer(config)
    return this
  }
}
