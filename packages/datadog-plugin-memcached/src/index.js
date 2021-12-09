'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

class MemcachedPlugin extends Plugin {
  static get name () {
    return 'memcached'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:memcached:command:start', () => {
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const span = this.tracer.startSpan('memcached.command', {
        childOf,
        tags: {
          'span.kind': 'client',
          'span.type': 'memcached',
          'service.name': this.config.service || `${this.tracer._service}-memcached`
        }
      })

      analyticsSampler.sample(span, this.config.measured)
      this.enter(span, store)
    })

    this.addSub('apm:memcached:command:end', () => {
      this.exit()
    })

    this.addSub('apm:memcached:command:start:with-args', ({ client, server, query }) => {
      const span = storage.getStore().span
      span.addTags({
        'resource.name': query.type,
        'memcached.command': query.command
      })

      const address = getAddress(client, server, query)

      if (address) {
        span.addTags({
          'out.host': address[0],
          'out.port': address[1]
        })
      }
    })

    this.addSub('apm:memcached:command:error', err => {
      const span = storage.getStore().span
      span.setTag('error', err)
    })

    this.addSub('apm:memcached:command:async-end', () => {
      const span = storage.getStore().span
      span.finish()
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
