'use strict'

const benchmark = require('../benchmark')
const Buffer = require('safe-buffer').Buffer
const platform = require('../../src/platform')
const node = require('../../src/platform/node')

platform.use(node)

const suite = benchmark('platform (node)')

let data

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
  .add('request', {
    onStart () {
      data = Buffer.alloc(1000000)
    },
    fn () {
      platform
        .request({
          protocol: 'http:',
          hostname: 'test',
          port: '8080',
          path: '/v0.4/traces',
          method: 'PUT',
          headers: {
            'Content-Type': 'application/msgpack'
          },
          data
        })
        .catch(() => {})
    }
  })
  .add('msgpack#prefix', {
    fn () {
      platform.msgpack.prefix(traceStub)
    }
  })

suite.run()
