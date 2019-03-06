'use strict'

const tx = require('./util/tx')
const analyticsSampler = require('../analytics_sampler')

function createWrapConnect (tracer, config) {
  return function wrapConnect (connect) {
    return function connectWithTrace () {
      const scope = tracer.scope()
      const options = getOptions(arguments)

      if (!options) return connect.apply(this, arguments)

      const span = options.path
        ? wrapIpc(tracer, config, this, options)
        : wrapTcp(tracer, config, this, options)

      analyticsSampler.sample(span, config.analytics)

      this.once('connect', tx.wrap(span))
      this.once('error', tx.wrap(span))

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

  socket.once('connect', () => {
    if (socket.localAddress) {
      span.addTags({
        'tcp.local.address': socket.localAddress,
        'tcp.local.port': socket.localPort
      })
    }
  })

  socket.once('lookup', (err, address) => {
    if (!err) {
      span.setTag('tcp.remote.address', address)
    }
  })

  return span
}

function wrapIpc (tracer, config, socket, options) {
  return startSpan(tracer, config, 'ipc', {
    'resource.name': options.path,
    'ipc.path': options.path
  })
}

function startSpan (tracer, config, protocol, tags) {
  const childOf = tracer.scope().active()
  const span = tracer.startSpan(`${protocol}.connect`, {
    childOf,
    tags: Object.assign({
      'span.kind': 'client',
      'service.name': config.service || `${tracer._service}-${protocol}`
    }, tags)
  })

  if (!childOf) {
    span.context()._sampled = false
  }

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

module.exports = {
  name: 'net',
  patch (net, tracer, config) {
    require('dns') // net will otherwise get an unpatched version for DNS lookups

    this.wrap(net.Socket.prototype, 'connect', createWrapConnect(tracer, config))
  },
  unpatch (net) {
    this.unwrap(net.Socket.prototype, 'connect')
  }
}
