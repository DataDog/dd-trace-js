'use strict'

const benchmark = require('./benchmark')
const proxyquire = require('proxyquire')

const Config = require('../packages/dd-trace/src/config')
const DatadogTracer = require('../packages/dd-trace/src/tracer')
const DatadogSpanContext = require('../packages/dd-trace/src/opentracing/span_context')
const TextMapPropagator = require('../packages/dd-trace/src/opentracing/propagation/text_map')
const Writer = proxyquire('../packages/dd-trace/src/exporters/agent/writer', {
  './request': () => Promise.resolve(),
  '../../encode/0.4': {
    AgentEncoder: function () {
      return { encode () {} }
    }
  }
})
const Sampler = require('../packages/dd-trace/src/sampler')
const format = require('../packages/dd-trace/src/format')
const { AgentEncoder: Agent04Encoder } = require('../packages/dd-trace/src/encode/0.4')
const { AgentEncoder: Agent05Encoder } = require('../packages/dd-trace/src/encode/0.5')
const config = new Config({ service: 'benchmark' })
const id = require('../packages/dd-trace/src/id')
const Histogram = require('../packages/dd-trace/src/histogram')
const histogram = new Histogram()
const metrics = require('../packages/dd-trace/src/metrics')
const log = require('../packages/dd-trace/src/log')

const encoder04 = new Agent04Encoder({ flush: () => encoder04.makePayload() })
const encoder05 = new Agent05Encoder({ flush: () => encoder05.makePayload() })

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
      writer = new Writer({ sample: () => {} })
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
  .add('encode (0.4)', {
    fn () {
      encoder04.encode([span])
    }
  })
  .add('encode (0.5)', {
    fn () {
      encoder05.encode([span])
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
  .add('metrics#boolean', {
    fn () {
      metrics.boolean('test', Math.random() < 0.5)
    }
  })
  .add('metrics#histogram', {
    fn () {
      metrics.histogram('test', Math.random() * 3.6e12)
    }
  })
  .add('metrics#gauge', {
    fn () {
      metrics.gauge('test', Math.random())
    }
  })
  .add('metrics#increment', {
    fn () {
      metrics.boolean('test')
    }
  })
  .add('metrics#increment (monotonic)', {
    fn () {
      metrics.boolean('test', true)
    }
  })
  .add('metrics#decrement', {
    fn () {
      metrics.boolean('test')
    }
  })
  .add('log (debug)', {
    onStart () {
      log.use({
        debug: () => {},
        error: () => {}
      })
      log.toggle(true, 'debug')
    },

    onComplete () {
      log.toggle(false)
    },

    fn () {
      log.debug('hello')
    }
  })
  .add('log (error)', {
    onStart () {
      log.use({
        debug: () => {},
        error: () => {}
      })
      log.toggle(true, 'error')
    },

    onComplete () {
      log.toggle(false)
    },

    fn () {
      log.error('boom')
    }
  })
  .add('log (none)', {
    onStart () {
      log.use({
        debug: () => {},
        error: () => {}
      })
      log.toggle(true, 'error')
    },

    onComplete () {
      log.toggle(false)
    },

    fn () {
      log.debug(() => (new Error('boom')).message)
    }
  })

suite.run()
