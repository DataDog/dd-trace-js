'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const CachePlugin = require('../../dd-trace/src/plugins/cache')

class MemcachedPlugin extends CachePlugin {
  static get id () { return 'memcached' }

  start ({ client, server, query }) {
    const address = getAddress(client, server, query)

    const meta = {
      'out.host': address[0],
      [CLIENT_PORT_KEY]: address[1]
    }

    if (this.config.memcachedCommandEnabled) {
      meta['memcached.command'] = query.command
    }

    this.startSpan({
      service: this.serviceName({ pluginConfig: this.config, system: this.system }),
      resource: query.type,
      type: 'memcached',
      meta
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
