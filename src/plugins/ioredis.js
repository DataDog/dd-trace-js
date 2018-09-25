'use strict'

function createWrapSendCommand (tracer, config) {
  return function wrapSendCommand (sendCommand) {
    return function sendCommandWithTrace (command, stream) {
      const scope = tracer.scopeManager().active()
      const span = tracer.startSpan('redis.command', {
        childOf: scope && scope.span(),
        tags: {
          'span.kind': 'client',
          'span.type': 'redis',
          'service.name': config.service || `${tracer._service}-redis`,
          'resource.name': command.name,
          'db.type': 'redis',
          'db.name': this.options.db || '0',
          'out.host': this.options.host,
          'out.port': String(this.options.port)
        }
      })

      command.promise
        .then(() => finish(span))
        .catch(err => finish(span, err))

      return sendCommand.apply(this, arguments)
    }
  }
}

function finish (span, error) {
  if (error) {
    span.addTags({
      'error.type': error.name,
      'error.msg': error.message,
      'error.stack': error.stack
    })
  }

  span.finish()
}

module.exports = {
  name: 'ioredis',
  versions: ['4.x'],
  patch (Redis, tracer, config) {
    this.wrap(Redis.prototype, 'sendCommand', createWrapSendCommand(tracer, config))
  },
  unpatch (Redis) {
    this.unwrap(Redis.prototype, 'sendCommand')
  }
}
