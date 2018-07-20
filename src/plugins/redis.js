'use strict'

const Tags = require('opentracing').Tags

function createWrapInternalSendCommand (tracer, config) {
  return function wrapInternalSendCommand (internalSendCommand) {
    return function internalSendCommandWithTrace (options) {
      const scope = tracer.scopeManager().active()
      const span = tracer.startSpan('redis.command', {
        childOf: scope && scope.span(),
        tags: {
          [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_CLIENT,
          [Tags.DB_TYPE]: 'redis',
          'service.name': config.service || `${tracer._service}-redis`,
          'resource.name': options.command,
          'span.type': 'redis',
          'db.name': this.selected_db || '0'
        }
      })

      if (this.connection_options) {
        span.addTags({
          'out.host': String(this.connection_options.host),
          'out.port': String(this.connection_options.port)
        })
      }

      options.callback = wrapCallback(tracer, span, options.callback)

      return internalSendCommand.call(this, options)
    }
  }
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

    if (done) {
      done(err, res)
    }
  }
}

function patch (redis, tracer, config) {
  this.wrap(redis.RedisClient.prototype, 'internal_send_command', createWrapInternalSendCommand(tracer, config))
}

function unpatch (redis) {
  this.unwrap(redis.RedisClient.prototype, 'internal_send_command')
}

module.exports = {
  name: 'redis',
  versions: ['^2.6'],
  patch,
  unpatch
}
