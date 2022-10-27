'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class DNSLookupPlugin extends ClientPlugin {
  static get name () { return 'dns' }
  static get operation () { return 'lookup' }

  start ([hostname]) {
    this.startSpan('dns.lookup', {
      service: this.config.service,
      resource: hostname,
      kind: 'client',
      meta: {
        'dns.hostname': hostname,
        'dns.address': '',
        'dns.addresses': ''
      }
    })
  }

  finish (result) {
    const span = this.activeSpan

    if (Array.isArray(result)) {
      const addresses = Array.isArray(result)
        ? result.map(address => address.address).sort()
        : [result]

      span.setTag('dns.address', addresses[0])
      span.setTag('dns.addresses', addresses.join(','))
    } else {
      span.setTag('dns.address', result)
    }

    span.finish()
  }
}

module.exports = DNSLookupPlugin
