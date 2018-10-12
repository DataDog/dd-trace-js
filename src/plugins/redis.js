'use strict'

const Tags = require('opentracing').Tags

function createWrapInternalSendCommand (tracer, config) {
  return function wrapInternalSendCommand (internalSendCommand) {
    return function internalSendCommandWithTrace (options) {
      const span = startSpan(tracer, config, this, options.command)

      options.callback = wrapCallback(tracer, span, options.callback)

      return internalSendCommand.call(this, options)
    }
  }
}

function createWrapSendCommand (tracer, config) {
  return function wrapSendCommand (sendCommand) {
    return function sendCommandWithTrace (command, args, callback) {
      const span = startSpan(tracer, config, this, command)

      if (callback) {
        callback = wrapCallback(tracer, span, callback)
      } else if (args) {
        args[(args.length || 1) - 1] = wrapCallback(tracer, span, args[args.length - 1])
      } else {
        args = [wrapCallback(tracer, span)]
      }

      return sendCommand.call(this, command, args, callback)
    }
  }
}

function startSpan (tracer, config, client, command) {
  const scope = tracer.scopeManager().active()
  const span = tracer.startSpan('redis.command', {
    childOf: scope && scope.span(),
    tags: {
      [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_CLIENT,
      [Tags.DB_TYPE]: 'redis',
      'service.name': config.service || `${tracer._service}-redis`,
      'resource.name': command,
      'span.type': 'redis',
      'db.name': client.selected_db || '0'
    }
  })

  const connectionOptions = client.connection_options || client.connection_option || {
    host: client.options.host || '127.0.0.1',
    port: client.options.port || 6379
  }

  if (connectionOptions) {
    span.addTags({
      'out.host': String(connectionOptions.host),
      'out.port': String(connectionOptions.port)
    })
  }

  return span
}

function wrapCallback (tracer, span, done) {
  return (err, res) => {
    if (err) {
      span.addTags({
        'error.type': err.name,
        'error.msg': err.message,
        'error.stack': err.stack
      })
    }

    span.finish()

    if (typeof done === 'function') {
      done(err, res)
    }
  }
}

module.exports = [
  {
    name: 'redis',
    versions: ['^2.6'],
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
