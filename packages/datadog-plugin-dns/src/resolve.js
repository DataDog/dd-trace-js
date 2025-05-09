'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class DNSResolvePlugin extends ClientPlugin {
  static get id () { return 'dns' }
  static get operation () { return 'resolve' }

  bindStart (ctx) {
    const [hostname, maybeType] = ctx.args
    const rrtype = typeof maybeType === 'string' ? maybeType : 'A'

    this.startSpan('dns.resolve', {
      service: this.config.service,
      resource: `${rrtype} ${hostname}`,
      kind: 'client',
      meta: {
        'dns.hostname': hostname,
        'dns.rrtype': rrtype
      }
    }, ctx)

    return ctx.currentStore
  }
}

module.exports = DNSResolvePlugin
