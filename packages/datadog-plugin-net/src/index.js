'use strict'

const tx = require('../../dd-trace/src/plugins/util/tx')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const { storage } = require('../../datadog-core')

function createWrapConnect (tracer, config) {
  return function wrapConnect (connect) {
    return function connectWithTrace () {
      const store = storage.getStore()

      if (store && store.noop) return connect.apply(this, arguments)

      const scope = tracer.scope()
      const options = getOptions(arguments)
      const lastIndex = arguments.length - 1
      const callback = arguments[lastIndex]

      if (!options) return connect.apply(this, arguments)

      if (typeof callback === 'function') {
        arguments[lastIndex] = scope.bind(callback)
      }

      const span = options.path
        ? wrapIpc(tracer, config, this, options)
        : wrapTcp(tracer, config, this, options)

      analyticsSampler.sample(span, config.measured)

      return scope.bind(connect, span).apply(this, arguments)
    }
  }
}

function wrapTcp (tracer, config, socket, options) {
  const host = options.host || 'localhost'
  const port = options.port || 0
  const family = options.family || 4

  const span = startSpan(tracer, config, 'tcp', {
    'resource.name': [host, port].filter(val => val).join(':'),
    'tcp.remote.host': host,
    'tcp.remote.port': port,
    'tcp.family': `IPv${family}`,
    'out.host': host,
    'out.port': port
  })

  setupListeners(socket, span, 'tcp')

  return span
}

function wrapIpc (tracer, config, socket, options) {
  const span = startSpan(tracer, config, 'ipc', {
    'resource.name': options.path,
    'ipc.path': options.path
  })

  setupListeners(socket, span, 'ipc')

  return span
}

function startSpan (tracer, config, protocol, tags) {
  const childOf = tracer.scope().active()
  const span = tracer.startSpan(`${protocol}.connect`, {
    childOf,
    tags: Object.assign({
      'span.kind': 'client',
      'service.name': config.service || tracer._service
    }, tags)
  })

  return span
}

function getOptions (args) {
  if (!args[0]) return

  switch (typeof args[0]) {
    case 'object':
      if (Array.isArray(args[0])) return getOptions(args[0])
      return args[0]
    case 'string':
      if (isNaN(parseFloat(args[0]))) {
        return {
          path: args[0]
        }
      }
    case 'number': // eslint-disable-line no-fallthrough
      return {
        port: args[0],
        host: typeof args[1] === 'string' ? args[1] : 'localhost'
      }
  }
}

function setupListeners (socket, span, protocol) {
  const events = ['connect', 'error', 'close', 'timeout']

  const wrapListener = tx.wrap(span)

  const localListener = () => {
    span.addTags({
      'tcp.local.address': socket.localAddress,
      'tcp.local.port': socket.localPort
    })
  }

  const cleanupListener = () => {
    socket.removeListener('connect', localListener)

    events.forEach(event => {
      socket.removeListener(event, wrapListener)
      socket.removeListener(event, cleanupListener)
    })
  }

  if (protocol === 'tcp') {
    socket.once('connect', localListener)
  }

  events.forEach(event => {
    socket.once(event, wrapListener)
    socket.once(event, cleanupListener)
  })
}

module.exports = {
  name: 'net',
  patch (net, tracer, config) {
    require('dns') // net will otherwise get an unpatched version for DNS lookups

    tracer.scope().bind(net.Socket.prototype)

    this.wrap(net.Socket.prototype, 'connect', createWrapConnect(tracer, config))
  },
  unpatch (net, tracer) {
    tracer.scope().unbind(net.Socket.prototype)

    this.unwrap(net.Socket.prototype, 'connect')
  }
}
