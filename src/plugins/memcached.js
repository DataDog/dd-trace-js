'use strict'

function createWrapCommand (tracer, config) {
  return function wrapCommand (command) {
    return function commandWithTrace (queryCompiler, server) {
      const scope = tracer.scopeManager().active()
      const span = tracer.startSpan('memcached.command', {
        childOf: scope && scope.span(),
        tags: {
          'span.kind': 'client',
          'span.type': 'memcached',
          'service.name': config.service || `${tracer._service}-memcached`
        }
      })

      queryCompiler = wrapQueryCompiler(queryCompiler, this, server, span)

      return command.call(this, queryCompiler, server)
    }
  }
}

function wrapQueryCompiler (original, client, server, span) {
  return function () {
    const query = original.apply(this, arguments)
    const callback = query.callback

    span.addTags({
      'resource.name': query.type,
      'memcached.query': query.command
    })

    addHost(span, client, server, query)

    query.callback = function (err) {
      addError(span, err)

      span.finish()

      return callback.apply(this, arguments)
    }

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
  versions: ['^2.2'],
  patch (Memcached, tracer, config) {
    this.wrap(Memcached.prototype, 'command', createWrapCommand(tracer, config))
  },
  unpatch (Memcached) {
    this.unwrap(Memcached.prototype, 'command')
  }
}
