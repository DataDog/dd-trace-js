'use strict'

const benchmark = require('../benchmark')
const platform = require('../../src/platform')
const node = require('../../src/platform/node')

platform.use(node)

const suite = benchmark('platform (node)')

const traceStub = require('../stubs/trace')

suite
  .add('id', {
    fn () {
      platform.id()
    }
  })
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

suite.run()
