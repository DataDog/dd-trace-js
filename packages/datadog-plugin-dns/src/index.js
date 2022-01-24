'use strict'

const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')

class DNSPlugin extends Plugin {
  static get name () {
    return 'dns'
  }

  addSubs (func, start, asyncEnd = defaultAsyncEnd) {
    this.addSub(`apm:dns:${func}:start`, start)
    this.addSub(`apm:dns:${func}:end`, this.exit.bind(this))
    this.addSub(`apm:dns:${func}:error`, errorHandler)
    this.addSub(`apm:dns:${func}:async-end`, asyncEnd)
  }

  startSpan (name, customTags, store) {
    const tags = {
      'service.name': this.config.service || this.tracer._service,
      'span.kind': 'client'
    }
    for (const tag in customTags) {
      tags[tag] = customTags[tag]
    }
    const span = this.tracer.startSpan(name, {
      childOf: store ? store.span : null,
      tags
    })
    analyticsSampler.sample(span, this.config.measured)
    return span
  }

  constructor (...args) {
    super(...args)

    this.addSubs('lookup', ([hostname]) => {
      const store = storage.getStore()
      const span = this.startSpan('dns.lookup', {
        'resource.name': hostname,
        'dns.hostname': hostname
      }, store)
      this.enter(span, store)
    }, (result) => {
      const { span } = storage.getStore()
      span.setTag('dns.address', result)
      span.finish()
    })

    this.addSubs('lookup_service', ([address, port]) => {
      const store = storage.getStore()
      const span = this.startSpan('dns.lookup_service', {
        'resource.name': `${address}:${port}`,
        'dns.address': address,
        'dns.port': port
      }, store)
      this.enter(span, store)
    })

    this.addSubs('resolve', ([hostname, maybeType]) => {
      const store = storage.getStore()
      const rrtype = typeof maybeType === 'string' ? maybeType : 'A'
      const span = this.startSpan('dns.resolve', {
        'resource.name': `${rrtype} ${hostname}`,
        'dns.hostname': hostname,
        'dns.rrtype': rrtype
      }, store)
      this.enter(span, store)
    })

    this.addSubs('reverse', ([ip]) => {
      const store = storage.getStore()
      const span = this.startSpan('dns.reverse', { 'resource.name': ip, 'dns.ip': ip }, store)
      this.enter(span, store)
    })
  }
}

function defaultAsyncEnd () {
  storage.getStore().span.finish()
}

function errorHandler (error) {
  storage.getStore().span.setTag('error', error)
}

module.exports = DNSPlugin
