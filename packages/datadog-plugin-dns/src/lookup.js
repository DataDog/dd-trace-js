'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class DNSLookupPlugin extends ClientPlugin {
  static get id () { return 'dns' }
  static get operation () { return 'lookup' }

  bindStart (ctx) {
    const [hostname] = ctx.args

    this.startSpan('dns.lookup', {
      service: this.config.service,
      resource: hostname,
      kind: 'client',
      meta: {
        'dns.hostname': hostname,
        'dns.address': '',
        'dns.addresses': ''
      }
    }, ctx)

    return ctx.currentStore
  }

  bindFinish (ctx) {
    const span = ctx.currentStore.span
    const result = ctx.result

    if (Array.isArray(result)) {
      const addresses = Array.isArray(result)
        ? result.map(address => address.address).sort()
        : [result]

      span.setTag('dns.address', addresses[0])
      span.setTag('dns.addresses', addresses.join(','))
    } else {
      span.setTag('dns.address', result)
    }

    return ctx.parentStore
  }
}

module.exports = DNSLookupPlugin
