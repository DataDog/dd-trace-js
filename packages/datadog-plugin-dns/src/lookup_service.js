'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class DNSLookupServicePlugin extends ClientPlugin {
  static get id () { return 'dns' }
  static get operation () { return 'lookup_service' }

  bindStart (ctx) {
    const [address, port] = ctx.args

    this.startSpan('dns.lookup_service', {
      service: this.config.service,
      resource: `${address}:${port}`,
      kind: 'client',
      meta: {
        'dns.address': address
      },
      metrics: {
        'dns.port': port
      }
    }, ctx)

    return ctx.currentStore
  }
}

module.exports = DNSLookupServicePlugin
