'use strict'

const benchmark = require('../benchmark')
const platform = require('../../packages/dd-trace/src/platform')
const node = require('../../packages/dd-trace/src/platform/node')

platform.use(node)

const suite = benchmark('platform (node)')

const spanStub = require('../stubs/span')

suite
  .add('now', {
    fn () {
      platform.now()
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
