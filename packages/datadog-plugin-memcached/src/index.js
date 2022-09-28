'use strict'

const CachePlugin = require('../../dd-trace/src/plugins/cache')

class MemcachedPlugin extends CachePlugin {
  static get name () { return 'memcached' }

  start ({ client, server, query }) {
    const address = getAddress(client, server, query)

    this.startSpan('memcached.command', {
      service: this.config.service,
      resource: query.type,
      type: 'memcached',
      kind: 'client',
      meta: {
        'memcached.command': query.command,
        'out.host': address[0],
        'out.port': address[1]
      }
    })
  }
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

module.exports = MemcachedPlugin
