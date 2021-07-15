'use strict'

let tracer
if (Number(process.env.USE_TRACER)) {
  tracer = require('../../..').init()
}

const bunyan = require('../../../versions/bunyan/node_modules/bunyan')
const { Writable } = require('stream')

const count = process.env.COUNT ? Number(process.env.COUNT) : 1000000

const logger = bunyan.createLogger({
  name: 'myapp',
  stream: new Writable({
    write (_chunk, _enc, cb) { cb() }
  })
})

function logABunch () {
  for (let i = 0; i < count; i++) {
    logger.info({ some: 'stuff' })
  }
}

if (tracer) {
  tracer.trace('myapp', {}, logABunch)
} else {
  logABunch()
}
