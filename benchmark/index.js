'use strict'

var Benchmark = require('benchmark')
var DatadogTracer = require('./src/opentracing/tracer')

var suite = new Benchmark.Suite()
var tracer = new DatadogTracer()

suite
  .add('DatadogTracer#startSpan', function () {
    tracer.startSpan()
  })
  .on('cycle', function (event) {
    console.log(String(event.target)) // eslint-disable-line no-console
  })
  .run({ 'async': true })
