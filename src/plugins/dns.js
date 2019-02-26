'use strict'

const analyticsSampler = require('../analytics_sampler')
const tx = require('./util/tx')

const rrtypes = {
  resolveAny: 'ANY',
  resolve4: 'A',
  resolve6: 'AAAA',
  resolveCname: 'CNAME',
  resolveMx: 'MX',
  resolveNs: 'NS',
  resolveTxt: 'TXT',
  resolveSrv: 'SRV',
  resolvePtr: 'PTR',
  resolveNaptr: 'NAPTR',
  resolveSoa: 'SOA'
}

function createWrapLookup (tracer, config) {
  return function wrapLookup (lookup) {
    return function lookupWithTrace (hostname, options, callback) {
      const span = startSpan(tracer, config, 'dns.lookup', {
        'resource.name': hostname,
        'dns.hostname': hostname
      })

      wrapArgs(span, arguments)

      return tracer.scope().activate(span, () => lookup.apply(this, arguments))
    }
  }
}

function createWrapLookupService (tracer, config) {
  return function wrapLookupService (lookupService) {
    return function lookupServiceWithTrace (address, port, callback) {
      const span = startSpan(tracer, config, 'dns.lookup_service', {
        'resource.name': `${address}:${port}`,
        'dns.address': address,
        'dns.port': port
      })

      wrapArgs(span, arguments)

      return tracer.scope().activate(span, () => lookupService.apply(this, arguments))
    }
  }
}

function createWrapResolve (tracer, config) {
  return function wrapResolve (resolve) {
    return function resolveWithTrace (hostname, rrtype, callback) {
      if (typeof rrtype !== 'string') {
        rrtype = 'A'
      }

      const span = wrapResolver(tracer, config, rrtype, arguments)

      return tracer.scope().activate(span, () => resolve.apply(this, arguments))
    }
  }
}

function createWrapResolver (tracer, config, rrtype) {
  return function wrapResolve (resolve) {
    return function resolveWithTrace (hostname, callback) {
      const span = wrapResolver(tracer, config, rrtype, arguments)

      return tracer.scope().activate(span, () => resolve.apply(this, arguments))
    }
  }
}

function createWrapReverse (tracer, config) {
  return function wrapReverse (reverse) {
    return function reverseWithTrace (ip, callback) {
      const span = startSpan(tracer, config, 'dns.reverse', {
        'resource.name': ip,
        'dns.ip': ip
      })

      wrapArgs(span, arguments)

      return tracer.scope().activate(span, () => reverse.apply(this, arguments))
    }
  }
}

function startSpan (tracer, config, operation, tags) {
  const childOf = tracer.scope().active()
  const span = tracer.startSpan(operation, {
    childOf,
    tags: Object.assign({
      'span.kind': 'client',
      'service.name': config.service || `${tracer._service}-dns`
    }, tags)
  })

  analyticsSampler.sample(span, config.analytics)

  return span
}

function wrapArgs (span, args) {
  args[args.length - 1] = tx.wrap(span, args[args.length - 1])
}

function wrapResolver (tracer, config, rrtype, args) {
  const hostname = args[0]
  const span = startSpan(tracer, config, 'dns.resolve', {
    'resource.name': `${rrtype} ${hostname}`,
    'dns.hostname': hostname,
    'dns.rrtype': rrtype
  })

  wrapArgs(span, args)

  return span
}

module.exports = [
  {
    name: 'dns',
    patch (dns, tracer, config) {
      this.wrap(dns, 'lookup', createWrapLookup(tracer, config))
      this.wrap(dns, 'lookupService', createWrapLookupService(tracer, config))
      this.wrap(dns, 'resolve', createWrapResolve(tracer, config))
      this.wrap(dns, 'reverse', createWrapReverse(tracer, config))

      Object.keys(rrtypes).forEach(method => {
        this.wrap(dns, method, createWrapResolver(tracer, config, rrtypes[method]))
      })

      if (dns.Resolver) {
        this.wrap(dns.Resolver.prototype, 'resolve', createWrapResolve(tracer, config))
        this.wrap(dns.Resolver.prototype, 'reverse', createWrapReverse(tracer, config))

        Object.keys(rrtypes).forEach(method => {
          this.wrap(dns.Resolver.prototype, method, createWrapResolver(tracer, config, rrtypes[method]))
        })
      }
    },
    unpatch (dns) {
      this.unwrap(dns, [
        'lookup',
        'lookupService',
        'resolve',
        'reverse'
      ])

      Object.keys(rrtypes).forEach(method => {
        this.unwrap(dns, method)
      })

      if (dns.Resolver) {
        this.unwrap(dns.prototype.Resolver, [
          'resolve',
          'reverse'
        ])

        Object.keys(rrtypes).forEach(method => {
          this.unwrap(dns.prototype.Resolver, method)
        })
      }
    }
  }
]
