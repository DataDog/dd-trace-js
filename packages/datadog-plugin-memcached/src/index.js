'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const CachePlugin = require('../../dd-trace/src/plugins/cache')
const {
  configuredService,
  configuredSystemService,
  optionServiceSource,
  storageServiceSource,
} = require('../../dd-trace/src/service-naming/helpers')

/** @type {import('../../dd-trace/src/plugins/tracing').NamingSchema} */
const namingSchema = {
  v0: {
    operationName: () => 'memcached.command',
    serviceName: configuredSystemService,
    serviceSource: storageServiceSource('memcached'),
  },
  v1: {
    operationName: () => 'memcached.command',
    serviceName: configuredService,
    serviceSource: optionServiceSource,
  },
}

class MemcachedPlugin extends CachePlugin {
  static id = 'memcached'

  /** @override */
  getNamingSchema () {
    return namingSchema
  }

  bindStart (ctx) {
    const { client, server, query } = ctx

    const address = getAddress(client, server, query)

    const meta = {
      'out.host': address[0],
      [CLIENT_PORT_KEY]: address[1],
    }

    if (this.config.DD_TRACE_MEMCACHED_COMMAND_ENABLED) {
      meta['memcached.command'] = query.command
    }

    this.startSpan({
      service: this.serviceName({ pluginConfig: this.config, system: this.system }),
      resource: query.type,
      type: 'memcached',
      meta,
    }, ctx)

    return ctx.currentStore
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
