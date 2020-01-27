'use strict'

if (process.env.DD_ENABLE) {
  const tracer = require('../..').init({})
}
const { Server } = require('http')
const origEmit = Server.prototype.emit
Server.prototype.emit = function (name) {
  if (name === 'listening') { process.send && process.send({ ready: true }) }
  return origEmit.apply(this, arguments)
}
