'use strict'

const Tags = require('opentracing').Tags
const shimmer = require('shimmer')

function createWrapCreateClient (tracer) {
  return function wrapCreateClient (createClient) {
    return function createClientWithTrace () {
      const client = createClient.apply(this, arguments)
      tracer.bindEmitter(client)
      return client
    }
  }
}

function createWrapCreateStream (tracer) {
  return function wrapCreateStream (createStream) {
    return function createStreamWithTrace () {
      createStream.apply(this, arguments)
      tracer.bindEmitter(this.stream)
    }
  }
}

function createWrapInternalSendCommand (tracer, config) {
  return function wrapInternalSendCommand (internalSendCommand) {
    return function internalSendCommandWithTrace (options) {
      tracer.trace(`redis.command`, {
        tags: {
          [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_CLIENT,
          [Tags.DB_TYPE]: 'redis'
        }
      }, span => {
        span.addTags({
          'service.name': config.service || 'redis',
          'resource.name': options.command,
          'span.type': 'db',
          'db.name': this.selected_db || '0',
          'out.host': String(this.connection_options.host),
          'out.port': String(this.connection_options.port)
        })

        options.callback = wrapCallback(tracer, span, options.callback)
      })

      return internalSendCommand.call(this, options)
    }
  }
}

function wrapCallback (tracer, span, done) {
  return tracer.bind((err, res) => {
    if (err) {
      span.addTags({
        'error.type': err.name,
        'error.msg': err.message,
        'error.stack': err.stack
      })
    }

    span.finish()

    if (done) {
      done(err, res)
    }
  })
}

function patch (redis, tracer, config) {
  shimmer.wrap(redis.RedisClient.prototype, 'internal_send_command', createWrapInternalSendCommand(tracer, config))
  shimmer.wrap(redis, 'createClient', createWrapCreateClient(tracer, config))
  shimmer.wrap(redis.RedisClient.prototype, 'create_stream', createWrapCreateStream(tracer, config))
}

function unpatch (redis) {
  shimmer.unwrap(redis.RedisClient.prototype, 'internal_send_command')
  shimmer.unwrap(redis, 'createClient')
  shimmer.unwrap(redis.RedisClient.prototype, 'create_stream')
}

module.exports = {
  name: 'redis',
  versions: ['>=2.6'],
  patch,
  unpatch
}
