'use strict'

const benchmark = require('./benchmark')
const proxyquire = require('proxyquire')
const platform = require('../packages/dd-trace/src/platform')
const node = require('../packages/dd-trace/src/platform/node')

platform.use(node)

const Config = require('../packages/dd-trace/src/config')
const DatadogTracer = require('../packages/dd-trace/src/tracer')
const DatadogSpanContext = require('../packages/dd-trace/src/opentracing/span_context')
const TextMapPropagator = require('../packages/dd-trace/src/opentracing/propagation/text_map')
const Writer = proxyquire('../packages/dd-trace/src/exporters/agent/writer', {
  './platform': { request: () => Promise.resolve() }
})
const Sampler = require('../packages/dd-trace/src/sampler')
const format = require('../packages/dd-trace/src/format')
const encode = require('../packages/dd-trace/src/encode')
const config = new Config('benchmark', { service: 'benchmark' })
const id = require('../packages/dd-trace/src/id')
const Histogram = require('../packages/dd-trace/src/histogram')
const histogram = new Histogram()

const suite = benchmark('core')

let tracer
let spanContext
let propagator
let carrier
let writer
let sampler

const spanStub = require('./stubs/span')
const span = format(spanStub)

suite
  .add('DatadogTracer#startSpan', {
    onStart () {
      tracer = new DatadogTracer(config)
    },
    fn () {
      tracer.startSpan()
    }
  })
  .add('TextMapPropagator#inject', {
    onStart () {
      propagator = new TextMapPropagator(config)
      carrier = {}
      spanContext = new DatadogSpanContext({
        traceId: id('1234567812345678'),
        spanId: id('1234567812345678'),
        baggageItems: { foo: 'bar' }
      })
    },
    fn () {
      propagator.inject(spanContext, carrier)
    }
  })
  .add('TextMapPropagator#extract', {
    onStart () {
      propagator = new TextMapPropagator(config)
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
      writer = new Writer({ sample: () => {} }, {})
    },
    fn () {
      writer.append([span])
    }
  })
  .add('Sampler#isSampled', {
    onStart () {
      sampler = new Sampler(0.5)
    },
    fn () {
      sampler.isSampled()
    }
  })
  .add('format', {
    fn () {
      format(spanStub)
    }
  })
  .add('encode', {
    fn () {
      encode([span])
    }
  })
  .add('id', {
    fn () {
      id()
    }
  })
  .add('Histogram', {
    fn () {
      histogram.record(Math.round(Math.random() * 3.6e12))
    }
  })

suite.run()
