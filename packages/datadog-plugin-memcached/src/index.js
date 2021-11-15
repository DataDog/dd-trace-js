'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

let theSpan

class MemcachedPlugin extends Plugin {

  static get name () {
    return 'memcached'
  }

  constructor (config) {
    super(config)

    this.addSub('apm:memcached:command:start', () => {
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const span = tracer().startSpan('memcached.command', {
        childOf,
        tags: {
          'span.kind': 'client',
          'span.type': 'memcached',
          'service.name': this.config.service || `${tracer()._service}-memcached`
        }
      })
      theSpan = span

      analyticsSampler.sample(span, this.config.measured)
      this.enter(span, store)
    })

    this.addSub('apm:memcached:command:end', () => {
      this.exit()
    })

    this.addSub('apm:memcached:query-cb:start', ({ client, server, query }) => {
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

    this.addSub('apm:memcached:query-cb:async-end', err => {
      const span = storage.getStore().span
      if (err) {
        span.setTag('error', err)
      }
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

function tracer () {
  return global._ddtrace._tracer
}

module.exports = MemcachedPlugin
