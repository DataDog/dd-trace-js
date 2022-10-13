'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class DNSLookupServicePlugin extends ClientPlugin {
  static get name () { return 'dns' }
  static get operation () { return 'lookup_service' }

  start ([address, port]) {
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
    })
  }
}

module.exports = DNSLookupServicePlugin
