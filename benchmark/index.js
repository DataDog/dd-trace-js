'use strict'

const Benchmark = require('benchmark')
const Buffer = require('safe-buffer').Buffer
const EventEmitter = require('events')
const proxyquire = require('proxyquire')
const semver = require('semver')
const Uint64BE = require('int64-buffer').Uint64BE
const platform = require('../src/platform')
const node = require('../src/platform/node')
const cls = require('../src/platform/node/context/cls')

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

Benchmark.options.maxTime = 0
Benchmark.options.minSamples = 5

const suite = new Benchmark.Suite()

let tracer
let spanContext
let propagator
let carrier
let writer
let sampler
let emitter
let queue
let data

const traceStub = require('./stubs/trace')
const spanStub = require('./stubs/span')

suite
  .add('DatadogTracer#trace', {
    onStart () {
      tracer = new DatadogTracer(config)
    },
    fn () {
      tracer.trace('bench', () => {})
    }
  })
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
  .add('Writer#flush (1000 items)', {
    onStart () {
      writer = new Writer({}, 1001)

      for (let i = 0; i < 1000; i++) {
        writer.append(spanStub)
      }

      queue = writer._queue
    },
    fn () {
      writer._queue = queue
      writer.flush()
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
  .add('platform#id (Node)', {
    fn () {
      platform.id()
    }
  })
  .add('platform#now (Node)', {
    fn () {
      platform.now()
    }
  })
  .add('platform#request (Node)', {
    onStart () {
      data = Buffer.alloc(1000000)
    },
    fn () {
      platform
        .request({
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
        .catch(() => {})
    }
  })
  .add('cls#run (Node)', {
    fn () {
      cls.run(() => {})
    }
  })
  .add('cls#bind (Node)', {
    fn () {
      cls.bind(() => {})
    }
  })
  .add('cls#bindEmitter (Node)', {
    onStart () {
      emitter = new EventEmitter()
    },
    fn () {
      cls.bindEmitter(emitter)
    }
  })
  .add('msgpack#prefix (Node)', {
    fn () {
      platform.msgpack.prefix(traceStub)
    }
  })

if (semver.gte(semver.valid(process.version), '8.2.0')) {
  const cls = require('../src/platform/node/context/cls_hooked')

  suite
    .add('clsHooked#run (Node)', {
      fn () {
        cls.run(() => {})
      }
    })
    .add('clsHooked#bind (Node)', {
      fn () {
        cls.bind(() => {})
      }
    })
    .add('clsHooked#bindEmitter (Node)', {
      onStart () {
        emitter = new EventEmitter()
      },
      fn () {
        cls.bindEmitter(emitter)
      }
    })
}

suite
  .on('cycle', event => {
    console.log(String(event.target)) // eslint-disable-line no-console
  })
  .on('error', event => {
    console.log(String(event.target.error)) // eslint-disable-line no-console
  })
  .run({ 'async': true })
