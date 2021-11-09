'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')

// // TODO oops! we need to properly use this
// const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

const rrtypes = [
  'ANY',
  'A',
  'AAAA',
  'CNAME',
  'MX',
  'NS',
  'TXT',
  'SRV',
  'PTR',
  'NAPTR',
  'SOA'
]

class DNSPlugin extends Plugin {
  static get name () {
    return 'dns'
  }

  get kind () {
    return 'client'
  }

  addSubs (func, start, asyncEnd = defaultAsyncEnd) {
    this.addSub(`apm:dns:${func}:start`, start)
    this.addSub(`apm:dns:${func}:end`, this.exit.bind(this))
    this.addSub(`apm:dns:${func}:error`, errorHandler)
    this.addSub(`apm:dns:${func}:async-end`, asyncEnd)
  }

  constructor (config) {
    super(config)

    this.addSubs('lookup', ([hostname]) => {
      this.startSpanAndEnter('dns.lookup', {
        'resource.name': hostname,
        'dns.hostname': hostname
      })
    }, (result) => {
      const { span } = storage.getStore()
      span.setTag('dns.address', result)
      span.finish()
    })

    this.addSubs('lookup_service', ([address, port]) => {
      this.startSpanAndEnter('dns.lookup_service', {
        'resource.name': `${address}:${port}`,
        'dns.address': address,
        'dns.port': port
      })
    })

    this.addSubs('resolve', ([hostname, maybeType]) => {
      const rrtype = typeof maybeType === 'string' ? maybeType : 'A'
      this.startSpanAndEnter('dns.resolve', {
        'resource.name': `${rrtype} ${hostname}`,
        'dns.hostname': hostname,
        'dns.rrtype': rrtype
      })
    })

    for (const rrtype of rrtypes) {
      this.addSubs('resolve:' + rrtype, ([hostname]) => {
        this.startSpanAndEnter('dns.resolve', {
          'resource.name': `${rrtype} ${hostname}`,
          'dns.hostname': hostname,
          'dns.rrtype': rrtype
        })
      })
    }

    this.addSubs('reverse', ([ip]) => {
      this.startSpanAndEnter('dns.reverse', { 'resource.name': ip, 'dns.ip': ip })
    })
  }
}

function defaultAsyncEnd () {
  storage.getStore().span.finish()
}

function errorHandler (error) {
  storage.getStore().addError(error)
}

module.exports = DNSPlugin
