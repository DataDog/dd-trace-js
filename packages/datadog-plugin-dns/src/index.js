'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')

class DNSPlugin extends Plugin {
  static get name () {
    return 'dns'
  }

  addSubs (func, start, asyncEnd) {
    this.addSub(`apm:dns:${func}:start`, start)
    this.addSub(`apm:dns:${func}:end`, this.exit.bind(this))
    this.addSub(`apm:dns:${func}:error`, this.addError.bind(this))
    this.addSub(`apm:dns:${func}:async-end`, asyncEnd || this.finishSpan.bind(this, null))
  }

  startSpan (name, resource, meta) {
    return super.startSpan(name, {
      service: this.config.service || this.tracer._service,
      resource,
      kind: 'client',
      meta
    })
  }

  constructor (...args) {
    super(...args)

    this.addSubs('lookup', ([hostname]) => {
      this.startSpan('dns.lookup', hostname, {
        'dns.hostname': hostname
      })
    }, (result) => {
      const span = this.activeSpan
      span.meta['dns.address'] = result
      this.finishSpan(span)
    })

    this.addSubs('lookup_service', ([address, port]) => {
      this.startSpan('dns.lookup_service', `${address}:${port}`, {
        'dns.address': address,
        'dns.port': String(port)
      })
    })

    this.addSubs('resolve', ([hostname, maybeType]) => {
      const rrtype = typeof maybeType === 'string' ? maybeType : 'A'
      this.startSpan('dns.resolve', `${rrtype} ${hostname}`, {
        'dns.hostname': hostname,
        'dns.rrtype': rrtype
      })
    })

    this.addSubs('reverse', ([ip]) => {
      this.startSpan('dns.reverse', ip, { 'dns.ip': ip })
    })
  }
}

module.exports = DNSPlugin
