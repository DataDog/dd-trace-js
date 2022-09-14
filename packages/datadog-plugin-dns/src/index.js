'use strict'

const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const { Plugin, TracingSubscription } = require('../../dd-trace/src/plugins/plugin')

class DnsSub extends TracingSubscription {
  startSpan (name, customTags, store) {
    const span = this.plugin.tracer.startSpan(name, {
      childOf: store ? store.span : null,
      tags: Object.assign({
        'service.name': this.plugin.config.service || this.plugin.tracer._service,
        'span.kind': 'client'
      }, customTags)
    })
    analyticsSampler.sample(span, this.plugin.config.measured)
    return span
  }

  start ({ startArgs }, store) {
    return this._start(startArgs, store)
  }

  asyncEnd (ctx) {
    ctx.span.finish()
    this.plugin.exit(ctx)
  }
}

class DnsLookupSub extends DnsSub {
  prefix = 'apm:dns:lookup'

  _start ([hostname], store) {
    return this.startSpan('dns.lookup', {
      'resource.name': hostname,
      'dns.hostname': hostname
    }, store)
  }

  asyncEnd (ctx) {
    const { span, result } = ctx
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
    this.plugin.exit(ctx)
  }
}

class DnsLookupServiceSub extends DnsSub {
  prefix = 'apm:dns:lookup_service'

  _start ([address, port], store) {
    return this.startSpan('dns.lookup_service', {
      'resource.name': `${address}:${port}`,
      'dns.address': address,
      'dns.port': port
    }, store)
  }
}

class DnsResolveSub extends DnsSub {
  prefix = 'apm:dns:resolve'

  _start ([hostname, maybeType], store) {
    const rrtype = typeof maybeType === 'string' ? maybeType : 'A'
    return this.startSpan('dns.resolve', {
      'resource.name': `${rrtype} ${hostname}`,
      'dns.hostname': hostname,
      'dns.rrtype': rrtype
    }, store)
  }
}

class DnsReverseSub extends DnsSub {
  prefix = 'apm:dns:reverse'

  _start ([ip], store) {
    return this.startSpan('dns.reverse', { 'resource.name': ip, 'dns.ip': ip }, store)
  }
}

class DNSPlugin extends Plugin {
  static get name () {
    return 'dns'
  }

  get tracingSubscriptions () {
    return [
      DnsLookupSub,
      DnsLookupServiceSub,
      DnsResolveSub,
      DnsReverseSub
    ]
  }
}

module.exports = DNSPlugin
