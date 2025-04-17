'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class DNSLookupPlugin extends ClientPlugin {
  static get id () { return 'dns' }
  static get operation () { return 'lookup' }
  static get peerServicePrecursors () { return ['queuename'] }


  start ([hostname]) {
    const parentSpan = this.tracer.scope().active();

    const span = this.startSpan('dns.lookup', {
      service: this.config.service,
      resource: hostname,
      kind: 'client',
      meta: {
        'dns.hostname': hostname,
        'dns.address': '',
        'dns.addresses': ''
      }
    })

    if (parentSpan && parentSpan.context()._tags && parentSpan.context()._tags['queuename']) {
      span.setTag('queuename', parentSpan.context()._tags['queuename']);
    }
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

    super.finish()
  }
}

module.exports = DNSLookupPlugin
