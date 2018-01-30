'use strict'

const Benchmark = require('benchmark')
const Buffer = require('safe-buffer').Buffer
const proxyquire = require('proxyquire')
const Uint64BE = require('int64-buffer').Uint64BE
const platform = require('../src/platform')
const node = require('../src/platform/node')

platform.use(node)

const DatadogTracer = require('../src/opentracing/tracer')
const DatadogSpanContext = require('../src/opentracing/span_context')
const TextMapPropagator = require('../src/opentracing/propagation/text_map')
const Writer = proxyquire('../src/writer', {
  './platform': { request: () => {} }
})

Benchmark.options.maxTime = 0
Benchmark.options.minSamples = 5

const suite = new Benchmark.Suite()

let tracer
let spanContext
let propagator
let carrier
let writer
let queue
let data

const trace = require('./stubs/trace')

suite
  .add('DatadogTracer#startSpan', {
    onStart () {
      tracer = new DatadogTracer({ service: 'benchmark' })
    },
    fn () {
      tracer.startSpan()
    }
  })
  .add('TextMapPropagator#inject', {
    onStart () {
      propagator = new TextMapPropagator()
      carrier = {}
      spanContext = new DatadogSpanContext({
        traceId: new Uint64BE(0x12345678, 0x12345678),
        spanId: new Uint64BE(0x12345678, 0x12345678),
        baggageItems: { foo: 'bar' }
      })
    },
    fn () {
      propagator.inject(spanContext, carrier)
    }
  })
  .add('TextMapPropagator#extract', {
    onStart () {
      propagator = new TextMapPropagator()
      carrier = {
        'x-datadog-trace-id': '1234567891234567',
        'x-datadog-parent-id': '1234567891234567',
        'ot-baggage-foo': 'bar'
      }
    },
    fn () {
      propagator.extract(carrier)
    }
  })
  .add('Writer#append', {
    onStart () {
      writer = new Writer({})
    },
    fn () {
      writer.append(trace)
    }
  })
  .add('Writer#flush (1000 items)', {
    onStart () {
      writer = new Writer({})

      for (let i = 0; i < 1000; i++) {
        writer.append(trace)
      }

      queue = writer._queue
    },
    fn () {
      writer._queue = queue
      writer.flush()
    }
  })
  .add('Platform#id (Node)', {
    fn () {
      platform.id()
    }
  })
  .add('Platform#now (Node)', {
    fn () {
      platform.now()
    }
  })
  .add('Platform#request (Node)', {
    onStart () {
      data = Buffer.alloc(1000000)
    },
    fn () {
      platform.request({
        protocol: 'http:',
        hostname: 'test',
        port: '8080',
        path: '/v0.3/traces',
        method: 'PUT',
        headers: {
          'Content-Type': 'application/msgpack'
        },
        data
      })
    }
  })
  .add('Platform.msgpack#prefix (Node)', {
    fn () {
      platform.msgpack.prefix(trace)
    }
  })
  .on('cycle', event => {
    console.log(String(event.target)) // eslint-disable-line no-console
  })
  .on('error', event => {
    console.log(String(event.target.error)) // eslint-disable-line no-console
  })
  .run({ 'async': true })
