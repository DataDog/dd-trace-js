'use strict'

const benchmark = require('../benchmark')
const platform = require('../../packages/dd-trace/src/platform')
const node = require('../../packages/dd-trace/src/platform/node')
const Config = require('../../packages/dd-trace/src/config')

platform.use(node)

const suite = benchmark('platform (node)')

const traceStub = require('../stubs/trace')
const spanStub = require('../stubs/span')
const config = new Config('bench', {})

platform.configure(config)
platform.metrics().start()

suite
  .add('now', {
    fn () {
      platform.now()
    }
  })
  .add('msgpack#prefix', {
    fn () {
      platform.msgpack.prefix(traceStub)
    }
  })
  .add('metrics#track', {
    fn () {
      platform.metrics().track(spanStub).finish()
    }
  })
  .add('metrics#boolean', {
    fn () {
      platform.metrics().boolean('test', Math.random() < 0.5)
    }
  })
  .add('metrics#histogram', {
    fn () {
      platform.metrics().histogram('test', Math.random() * 3.6e12)
    }
  })
  .add('metrics#gauge', {
    fn () {
      platform.metrics().gauge('test', Math.random())
    }
  })
  .add('metrics#increment', {
    fn () {
      platform.metrics().boolean('test')
    }
  })
  .add('metrics#increment (monotonic)', {
    fn () {
      platform.metrics().boolean('test', true)
    }
  })
  .add('metrics#decrement', {
    fn () {
      platform.metrics().boolean('test')
    }
  })

suite.run()
