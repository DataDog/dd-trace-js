'use strict'

const Benchmark = require('benchmark')
const DatadogTracer = require('../src/opentracing/tracer')

const suite = new Benchmark.Suite()
const tracer = new DatadogTracer()

suite
  .add('DatadogTracer#startSpan', () => {
    tracer.startSpan()
  })
  .on('cycle', event => {
    console.log(String(event.target)) // eslint-disable-line no-console
  })
  .run({ 'async': true })
