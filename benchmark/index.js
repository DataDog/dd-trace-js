'use strict'

const Benchmark = require('benchmark')
const Buffer = require('safe-buffer').Buffer
const proxyquire = require('proxyquire')
const platform = require('../src/platform')
const node = require('../src/platform/node')

platform.use(node)

const DatadogTracer = require('../src/opentracing/tracer')
const Writer = proxyquire('../src/writer', {
  './platform': { request: () => {} }
})

Benchmark.options.maxTime = 0
Benchmark.options.minSamples = 5

const suite = new Benchmark.Suite()

let tracer
let writer
let queue
let data

const trace = require('./stubs/trace')

suite
  .add('DatadogTracer#startSpan', {
    onStart () {
      tracer = new DatadogTracer()
    },
    fn () {
      tracer.startSpan()
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
