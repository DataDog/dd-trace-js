'use strict'

const opentracing = require("opentracing");
const constants = require("../../dd-trace/src/constants")
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const tx = require('../../dd-trace/src/plugins/util/tx')

const Reference = opentracing.Reference

const REFERENCE_CHILD_OF = opentracing.REFERENCE_CHILD_OF
const REFERENCE_NOOP = constants.REFERENCE_NOOP

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
      if (!isArgsValid(arguments, 2)) return lookup.apply(this, arguments)

      const span = startSpan(tracer, config, 'dns.lookup', {
        'resource.name': hostname,
        'dns.hostname': hostname
      }, isIP(hostname))

      wrapArgs(span, arguments, (e, address) => {
        span.setTag('dns.address', address)
      })

      return tracer.scope().activate(span, () => lookup.apply(this, arguments))
    }
  }
}

function createWrapLookupService (tracer, config) {
  return function wrapLookupService (lookupService) {
    return function lookupServiceWithTrace (address, port, callback) {
      if (!isArgsValid(arguments, 3)) return lookupService.apply(this, arguments)

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
      if (!isArgsValid(arguments, 2)) return resolve.apply(this, arguments)

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
      if (!isArgsValid(arguments, 2)) return resolve.apply(this, arguments)

      const span = wrapResolver(tracer, config, rrtype, arguments)

      return tracer.scope().activate(span, () => resolve.apply(this, arguments))
    }
  }
}

function createWrapReverse (tracer, config) {
  return function wrapReverse (reverse) {
    return function reverseWithTrace (ip, callback) {
      if (!isArgsValid(arguments, 2)) return reverse.apply(this, arguments)

      const span = startSpan(tracer, config, 'dns.reverse', {
        'resource.name': ip,
        'dns.ip': ip
      })

      wrapArgs(span, arguments)

      return tracer.scope().activate(span, () => reverse.apply(this, arguments))
    }
  }
}

function startSpan (tracer, config, operation, tags, noop) {
  const childOf = tracer.scope().active()
  const type = noop ? REFERENCE_NOOP : REFERENCE_CHILD_OF
  const span = tracer.startSpan(operation, {
    references: [
      new Reference(type, childOf)
    ],
    tags: Object.assign({
      'span.kind': 'client',
      'service.name': config.service || `${tracer._service}-dns`
    }, tags)
  })

  analyticsSampler.sample(span, config.analytics)

  return span
}

function isArgsValid (args, minLength) {
  if (args.length < minLength) return false
  if (typeof args[args.length - 1] !== 'function') return false

  return true
}

function wrapArgs (span, args, callback) {
  const original = args[args.length - 1]
  const fn = tx.wrap(span, original)

  args[args.length - 1] = function () {
    callback && callback.apply(null, arguments)
    return fn.apply(this, arguments)
  }
}

function wrapResolver (tracer, config, rrtype, args) {
  const hostname = args[0]
  const span = startSpan(tracer, config, 'dns.resolve', {
    'resource.name': `${rrtype} ${hostname}`,
    'dns.hostname': hostname,
    'dns.rrtype': rrtype
  }, isIP(hostname))

  wrapArgs(span, args)

  return span
}

function patchResolveShorthands (tracer, config, shim, prototype) {
  Object.keys(rrtypes)
    .filter(method => !!prototype[method])
    .forEach(method => {
      shim.wrap(prototype, method, createWrapResolver(tracer, config, rrtypes[method]))
    })
}

function unpatchResolveShorthands (shim, prototype) {
  Object.keys(rrtypes)
    .filter(method => !!prototype[method])
    .forEach(method => {
      shim.unwrap(prototype, method)
    })
}

// IPv4 Segment
const v4Seg = '(?:[0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])'
const v4Str = `(${v4Seg}[.]){3}${v4Seg}`
const IPv4Reg = new RegExp(`^${v4Str}$`)

// IPv6 Segment
const v6Seg = '(?:[0-9a-fA-F]{1,4})';
const IPv6Reg = new RegExp('^(' +
  `(?:${v6Seg}:){7}(?:${v6Seg}|:)|` +
  `(?:${v6Seg}:){6}(?:${v4Str}|:${v6Seg}|:)|` +
  `(?:${v6Seg}:){5}(?::${v4Str}|(:${v6Seg}){1,2}|:)|` +
  `(?:${v6Seg}:){4}(?:(:${v6Seg}){0,1}:${v4Str}|(:${v6Seg}){1,3}|:)|` +
  `(?:${v6Seg}:){3}(?:(:${v6Seg}){0,2}:${v4Str}|(:${v6Seg}){1,4}|:)|` +
  `(?:${v6Seg}:){2}(?:(:${v6Seg}){0,3}:${v4Str}|(:${v6Seg}){1,5}|:)|` +
  `(?:${v6Seg}:){1}(?:(:${v6Seg}){0,4}:${v4Str}|(:${v6Seg}){1,6}|:)|` +
  `(?::((?::${v6Seg}){0,5}:${v4Str}|(?::${v6Seg}){1,7}|:))` +
')(%[0-9a-zA-Z-.:]{1,})?$')

function isIPv4(s) {
  return IPv4Reg.test(s)
}

function isIPv6(s) {
  return IPv6Reg.test(s)
}

function isIP(s) {
  return isIPv4(s) || isIPv6(s)
}

module.exports = [
  {
    name: 'dns',
    patch (dns, tracer, config) {
      this.wrap(dns, 'lookup', createWrapLookup(tracer, config))
      this.wrap(dns, 'lookupService', createWrapLookupService(tracer, config))
      this.wrap(dns, 'resolve', createWrapResolve(tracer, config))
      this.wrap(dns, 'reverse', createWrapReverse(tracer, config))

      patchResolveShorthands(tracer, config, this, dns)

      if (dns.Resolver) {
        this.wrap(dns.Resolver.prototype, 'resolve', createWrapResolve(tracer, config))
        this.wrap(dns.Resolver.prototype, 'reverse', createWrapReverse(tracer, config))

        patchResolveShorthands(tracer, config, this, dns.Resolver.prototype)
      }
    },
    unpatch (dns) {
      this.unwrap(dns, [
        'lookup',
        'lookupService',
        'resolve',
        'reverse'
      ])

      unpatchResolveShorthands(this, dns)

      if (dns.Resolver) {
        this.unwrap(dns.prototype.Resolver, [
          'resolve',
          'reverse'
        ])

        unpatchResolveShorthands(this, dns.Resolver.prototype)
      }
    }
  }
]
