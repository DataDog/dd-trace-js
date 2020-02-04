'use strict'

if (process.env.DD_ENABLE) {
  const tracer = require('../..').init({})
} else if (process.env.ASYNC_HOOKS) {
  const asyncHooks = require('async_hooks')
  const hook = asyncHooks.createHook({
    init () {},
    before () {},
    after () {},
    destroy () {}
  })
  hook.enable()
}
const { Server } = require('http')
const origEmit = Server.prototype.emit
Server.prototype.emit = function (name) {
  if (name === 'listening') { process.send && process.send({ ready: true }) }
  return origEmit.apply(this, arguments)
}
