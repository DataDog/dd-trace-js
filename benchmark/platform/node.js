'use strict'

const benchmark = require('../benchmark')
const Buffer = require('safe-buffer').Buffer
const EventEmitter = require('events')
const platform = require('../../src/platform')
const node = require('../../src/platform/node')
const cls = require('../../src/platform/node/context/cls')
const clsHooked = require('../../src/platform/node/context/cls_hooked')

platform.use(node)

const suite = benchmark('platform (node)')

let emitter
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
  .add('cls#run', {
    fn () {
      cls.run(() => {})
    }
  })
  .add('cls#bind', {
    fn () {
      cls.bind(() => {})
    }
  })
  .add('cls#bindEmitter', {
    onStart () {
      emitter = new EventEmitter()
    },
    fn () {
      cls.bindEmitter(emitter)
    }
  })
  .add('msgpack#prefix', {
    fn () {
      platform.msgpack.prefix(traceStub)
    }
  })
  .add('clsHooked#run', {
    fn () {
      clsHooked.run(() => {})
    }
  })
  .add('clsHooked#bind', {
    fn () {
      clsHooked.bind(() => {})
    }
  })
  .add('clsHooked#bindEmitter', {
    onStart () {
      emitter = new EventEmitter()
    },
    fn () {
      clsHooked.bindEmitter(emitter)
    }
  })

suite.run()
