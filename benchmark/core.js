'use strict'

const benchmark = require('./benchmark')
const proxyquire = require('proxyquire')
const Uint64BE = require('int64-buffer').Uint64BE
const platform = require('../src/platform')
const node = require('../src/platform/node')

platform.use(node)

const Config = require('../src/config')
const DatadogTracer = require('../src/tracer')
const DatadogSpanContext = require('../src/opentracing/span_context')
const TextMapPropagator = require('../src/opentracing/propagation/text_map')
const Writer = proxyquire('../src/writer', {
  './platform': { request: () => Promise.resolve() }
})
const Sampler = require('../src/sampler')
const format = require('../src/format')
const encode = require('../src/encode')
const config = new Config({ service: 'benchmark' })

const suite = benchmark('core')

let tracer
let spanContext
let propagator
let carrier
let writer
let sampler

const traceStub = require('./stubs/trace')
const spanStub = require('./stubs/span')

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
      writer = new Writer({}, 1000000)
    },
    fn () {
      writer.append(spanStub)
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
      encode(traceStub)
    }
  })

suite.run()
