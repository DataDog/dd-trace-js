'use strict'

const tx = require('./util/tx')

function createWrapConnect (tracer, config) {
  return function wrapConnect (connect) {
    return function connectWithTrace () {
      const options = getOptions(arguments)

      if (!options) return connect.apply(this, arguments)

      const span = startSpan(tracer, config)

      if (options.path) {
        span.addTags({
          'resource.name': `${options.path}`,
          'socket.type': 'ipc',
          'socket.path': options.path
        })
      } else if (options.port) {
        span.addTags({
          'resource.name': `${options.host}:${options.port}`,
          'socket.type': 'tcp',
          'socket.hostname': options.host,
          'socket.port': options.port
        })
      }

      this.once('connect', tx.wrap(span).bind(null))
      this.once('error', tx.wrap(span))

      return connect.apply(this, arguments)
    }
  }
}

function startSpan (tracer, config) {
  const scope = tracer.scopeManager().active()
  const span = tracer.startSpan('net.connect', {
    childOf: scope && scope.span(),
    tags: {
      'span.kind': 'client',
      'service.name': config.service || `${tracer._service}-net`
    }
  })

  return span
}

function getOptions (args) {
  if (!args[0]) return

  switch (typeof args[0]) {
    case 'object':
      if (Array.isArray(args[0])) return getOptions(args[0])
      if (typeof args[0].port === 'undefined' && typeof args[0].path === 'undefined') return
      return args[0]
    case 'number':
      return {
        port: args[0],
        host: typeof args[1] === 'string' ? args[1] : 'localhost'
      }
    case 'string':
      return {
        path: args[0]
      }
  }
}

module.exports = {
  name: 'net',
  patch (net, tracer, config) {
    this.wrap(net.Socket.prototype, 'connect', createWrapConnect(tracer, config))
  },
  unpatch (net) {
    this.unwrap(net.Socket.prototype, 'connect')
  }
}
