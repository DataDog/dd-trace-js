'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class DNSResolvePlugin extends ClientPlugin {
  static get name () { return 'dns' }
  static get operation () { return 'resolve' }

  start ({ args: [hostname, maybeType] }) {
    const rrtype = typeof maybeType === 'string' ? maybeType : 'A'

    this.startSpan('dns.resolve', {
      service: this.config.service,
      resource: `${rrtype} ${hostname}`,
      kind: 'client',
      meta: {
        'dns.hostname': hostname,
        'dns.rrtype': rrtype
      }
    })
  }
}

module.exports = DNSResolvePlugin
