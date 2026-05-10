'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class DNSLookupPlugin extends ClientPlugin {
  static id = 'dns'
  static operation = 'lookup'

  bindStart (ctx) {
    const [hostname] = ctx.args

    this.startSpan('dns.lookup', {
      service: this.config.service,
      resource: hostname,
      kind: 'client',
      meta: {
        'dns.hostname': hostname,
        'dns.address': '',
        'dns.addresses': '',
      },
    }, ctx)

    return ctx.currentStore
  }

  bindFinish (ctx) {
    const span = ctx.currentStore.span
    const result = ctx.result

    if (Array.isArray(result)) {
      // `lookup(..., { all: true })` or `dns.promises.lookup(..., { all: true })`.
      const addresses = result.map(entry => entry.address).sort()
      span.setTag('dns.address', addresses[0])
      span.setTag('dns.addresses', addresses.join(','))
    } else if (result && typeof result === 'object') {
      // `dns.promises.lookup(...)` resolves to `{ address, family }`; the callback variant
      // passes the address as a string.
      span.setTag('dns.address', result.address)
    } else {
      span.setTag('dns.address', result)
    }

    return ctx.parentStore
  }
}

module.exports = DNSLookupPlugin
