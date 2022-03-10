'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')

class MemcachedPlugin extends Plugin {
  static get name () {
    return 'memcached'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:memcached:command:start', () => {
      this.startSpan('memcached.command', {
        service: this.config.service || `${this.tracer.config.service}-memcached`,
        kind: 'client',
        type: 'memcached',
        meta: {
          'memcached.command': '',
          'out.host': '',
          'out.port': ''
        }
      })
    })

    this.addSub('apm:memcached:command:end', () => {
      this.exit()
    })

    this.addSub('apm:memcached:command:start:with-args', ({ client, server, query }) => {
      const address = getAddress(client, server, query)
      const span = this.activeSpan

      span.resource = query.type
      span.meta['memcached.command'] = query.command
      span.meta['out.host'] = address[0]
      span.meta['out.port'] = address[1]
    })

    this.addSub('apm:memcached:command:error', err => {
      this.addError(err)
    })

    this.addSub('apm:memcached:command:async-end', () => {
      this.finishSpan()
    })
  }
}

// TODO: move to the publisher
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

module.exports = MemcachedPlugin
