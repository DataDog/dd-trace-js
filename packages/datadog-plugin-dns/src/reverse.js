'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class DNSReversePlugin extends ClientPlugin {
  static id = 'dns'
  static operation = 'reverse'

  bindStart (ctx) {
    const [ip] = ctx.args

    this.startSpan('dns.reverse', {
      service: this.config.service,
      resource: ip,
      kind: 'client',
      meta: {
        'dns.ip': ip
      }
    }, ctx)

    return ctx.currentStore
  }
}

module.exports = DNSReversePlugin
