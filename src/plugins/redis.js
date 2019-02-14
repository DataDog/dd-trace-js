'use strict'

const tx = require('./util/redis')

function createWrapInternalSendCommand (tracer, config) {
  return function wrapInternalSendCommand (internalSendCommand) {
    return function internalSendCommandWithTrace (options) {
      const scope = tracer.scope()
      const span = startSpan(tracer, config, this, options.command, options.args)

      options.callback = scope.bind(tx.wrap(span, options.callback))

      return scope.bind(internalSendCommand, span).call(this, options)
    }
  }
}

function createWrapSendCommand (tracer, config) {
  return function wrapSendCommand (sendCommand) {
    return function sendCommandWithTrace (command, args, callback) {
      const scope = tracer.scope()
      const span = startSpan(tracer, config, this, command, args)

      if (typeof callback === 'function') {
        callback = scope.bind(tx.wrap(span, callback))
      } else if (Array.isArray(args) && typeof args[args.length - 1] === 'function') {
        args[args.length - 1] = scope.bind(tx.wrap(span, args[args.length - 1]))
      } else {
        callback = tx.wrap(span)
      }

      return scope.bind(sendCommand, span).call(this, command, args, callback)
    }
  }
}

function startSpan (tracer, config, client, command, args) {
  const db = client.selected_db
  const connectionOptions = client.connection_options || client.connection_option || {}
  const span = tx.instrument(tracer, config, db, command, args)

  tx.setHost(span, connectionOptions.host, connectionOptions.port)

  return span
}

module.exports = [
  {
    name: 'redis',
    versions: ['>=2.6'],
    patch (redis, tracer, config) {
      this.wrap(redis.RedisClient.prototype, 'internal_send_command', createWrapInternalSendCommand(tracer, config))
    },
    unpatch (redis) {
      this.unwrap(redis.RedisClient.prototype, 'internal_send_command')
    }
  },
  {
    name: 'redis',
    versions: ['>=0.12 <2.6'],
    patch (redis, tracer, config) {
      this.wrap(redis.RedisClient.prototype, 'send_command', createWrapSendCommand(tracer, config))
    },
    unpatch (redis) {
      this.unwrap(redis.RedisClient.prototype, 'send_command')
    }
  }
]
