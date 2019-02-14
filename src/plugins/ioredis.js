'use strict'

const tx = require('./util/redis')

function createWrapSendCommand (tracer, config) {
  return function wrapSendCommand (sendCommand) {
    return function sendCommandWithTrace (command, stream) {
      const db = this.options.db
      const span = tx.instrument(tracer, config, db, command.name, command.args)

      tx.setHost(span, this.options.host, this.options.port)
      tx.wrap(span, command.promise)

      return tracer.scope().bind(sendCommand, span).apply(this, arguments)
    }
  }
}

module.exports = {
  name: 'ioredis',
  versions: ['>=2'],
  patch (Redis, tracer, config) {
    this.wrap(Redis.prototype, 'sendCommand', createWrapSendCommand(tracer, config))
  },
  unpatch (Redis) {
    this.unwrap(Redis.prototype, 'sendCommand')
  }
}
