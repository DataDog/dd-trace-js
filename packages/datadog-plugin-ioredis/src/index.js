'use strict'

const tx = require('../../dd-trace/src/plugins/util/redis')

function createWrapSendCommand (tracer, config) {
  return function wrapSendCommand (sendCommand) {
    return function sendCommandWithTrace (command, stream) {
      if (!command || !command.promise) return sendCommand.apply(this, arguments)

      const options = this.options || {}
      const db = options.db
      const span = tx.instrument(tracer, config, db, command.name, command.args)

      tx.setHost(span, options.host, options.port)
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
