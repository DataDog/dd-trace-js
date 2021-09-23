'use strict'

const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

function createWrapCommand (tracer, config) {
  return function wrapCommand (command) {
    return function commandWithTrace (queryCompiler, server) {
      const scope = tracer.scope()
      const childOf = scope.active()
      const span = tracer.startSpan('memcached.command', {
        childOf,
        tags: {
          'span.kind': 'client',
          'span.type': 'memcached',
          'service.name': config.service || `${tracer._service}-memcached`
        }
      })

      analyticsSampler.sample(span, config.measured)

      arguments[0] = wrapQueryCompiler(queryCompiler, this, server, scope, span)

      return scope.bind(command, span).apply(this, arguments)
    }
  }
}

function wrapQueryCompiler (original, client, server, scope, span) {
  const parent = scope.active()

  return function () {
    const query = original.apply(this, arguments)
    const callback = query.callback

    span.addTags({
      'resource.name': query.type,
      'memcached.command': query.command
    })

    addHost(span, client, server, query)

    query.callback = scope.bind(function (err) {
      addError(span, err)

      span.finish()

      return callback.apply(this, arguments)
    }, parent)

    return query
  }
}

function addHost (span, client, server, query) {
  const address = getAddress(client, server, query)

  if (address) {
    span.addTags({
      'out.host': address[0],
      'out.port': address[1]
    })
  }
}

function addError (span, error) {
  if (error) {
    span.addTags({
      'error.type': error.name,
      'error.msg': error.message,
      'error.stack': error.stack
    })
  }

  return error
}

function getAddress (client, server, query) {
  if (!server) {
    if (client.servers.length === 1) {
      server = client.servers[0]
    } else {
      let redundancy = client.redundancy && client.redundancy < client.servers.length
      const queryRedundancy = query.redundancyEnabled

      if (redundancy && queryRedundancy) {
        redundancy = client.HashRing.range(query.key, (client.redundancy + 1), true)
        server = redundancy.shift()
      } else {
        server = client.HashRing.get(query.key)
      }
    }
  }

  return server && server.split(':')
}

module.exports = {
  name: 'memcached',
  versions: ['>=2.2'],
  patch (Memcached, tracer, config) {
    this.wrap(Memcached.prototype, 'command', createWrapCommand(tracer, config))
  },
  unpatch (Memcached) {
    this.unwrap(Memcached.prototype, 'command')
  }
}
