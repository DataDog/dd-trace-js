'use strict'

// TODO: use uppercase for command names

const tx = require('../../dd-trace/src/plugins/util/redis')

function createWrapAddCommand (tracer, config) {
  return function wrapAddCommand (addCommand) {
    return function addCommandWithTrace (command) {
      const name = command[0]
      const args = command.slice(1)

      if (!config.filter(name)) return addCommand.apply(this, arguments)

      const scope = tracer.scope()
      const span = startSpan(tracer, config, this, name, args)

      return tx.wrap(span, scope.bind(addCommand, span).apply(this, arguments))
    }
  }
}

function createWrapInternalSendCommand (tracer, config) {
  return function wrapInternalSendCommand (internalSendCommand) {
    return function internalSendCommandWithTrace (options) {
      if (!config.filter(options.command)) return internalSendCommand.apply(this, arguments)

      const scope = tracer.scope()
      const span = startSpan(tracer, config, this, options.command, options.args)

      options.callback = scope.bind(tx.wrap(span, options.callback))

      return scope.bind(internalSendCommand, span).apply(this, arguments)
    }
  }
}

function createWrapSendCommand (tracer, config) {
  return function wrapSendCommand (sendCommand) {
    return function sendCommandWithTrace (command, args, callback) {
      if (!config.filter(command)) return sendCommand.apply(this, arguments)

      const scope = tracer.scope()
      const span = startSpan(tracer, config, this, command, args)

      if (typeof callback === 'function') {
        arguments[2] = scope.bind(tx.wrap(span, callback))
      } else if (Array.isArray(args) && typeof args[args.length - 1] === 'function') {
        args[args.length - 1] = scope.bind(tx.wrap(span, args[args.length - 1]))
      } else {
        arguments[2] = tx.wrap(span)
      }

      return scope.bind(sendCommand, span).apply(this, arguments)
    }
  }
}

function startSpan (tracer, config, client, command, args) {
  const db = client.selected_db
  const connectionOptions = client.connection_options || client.connection_option || client.connectionOption || {}
  const span = tx.instrument(tracer, config, db, command, args)

  tx.setHost(span, connectionOptions.host, connectionOptions.port)

  return span
}

module.exports = [
  {
    name: '@node-redis/client',
    versions: ['>=1'],
    file: 'dist/lib/client/commands-queue.js',
    patch (redis, tracer, config) {
      config = tx.normalizeConfig(config)
      this.wrap(redis.default.prototype, 'addCommand', createWrapAddCommand(tracer, config))
    },
    unpatch (redis) {
      this.unwrap(redis.default.prototype, 'addCommand')
    }
  },
  {
    name: 'redis',
    versions: ['>=2.6 <4'],
    patch (redis, tracer, config) {
      config = tx.normalizeConfig(config)
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
      config = tx.normalizeConfig(config)
      this.wrap(redis.RedisClient.prototype, 'send_command', createWrapSendCommand(tracer, config))
    },
    unpatch (redis) {
      this.unwrap(redis.RedisClient.prototype, 'send_command')
    }
  }
]
