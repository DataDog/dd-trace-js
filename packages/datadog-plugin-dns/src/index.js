'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { wrap, addHook } = require('../../dd-trace/src/plugins/instrument')

// // TODO oops! we need to properly use this
// const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

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

const rrtypeMap = new WeakMap()

addHook({ name: 'dns' }, dns => {
  dns.lookup = wrap('apm:dns:lookup', dns.lookup)
  dns.lookupService = wrap('apm:dns:lookup', dns.lookupService)
  dns.resolve = wrap('apm:dns:lookup', dns.resolve)
  dns.reverse = wrap('apm:dns:reverse', dns.reverse)

  patchResolveShorthands(dns)

  if (dns.Resolver) {
    dns.Resolver.prototype.resolve = wrap('apm:dns:resolve', dns.Resolver.prototype.resolve)
    dns.Resolver.prototype.reverse = wrap('apm:dns:reverse', dns.Resolver.prototype.reverse)

    patchResolveShorthands(dns.Resolver.prototype)
  }

  return dns
})

class DNSPlugin extends Plugin {
  static get name () {
    return 'dns'
  }

  constructor (config) {
    super(config)
    this.addWrappedSubscriptions('apm:dns:lookup', 'dns.lookup', {
      tags: ({ context, args }) => {
        if (!isArgsValid(args, 2)) {
          context.noTrace = true
          return
        }
        return { 'resource.name': args[0], 'dns.hostname': args[0] }
      },
      asyncEnd: ({ context, result }) => context.span.setTag('dns.address', result[0])
    })
    this.addWrappedSubscriptions('apm:dns:lookup_service', 'dns.lookup_service', {
      tags: ({ context, args }) => {
        if (!isArgsValid(args, 3)) {
          context.noTrace = true
          return
        }
        const [address, port] = args
        return {
          'resource.name': `${address}:${port}`,
          'dns.address': address,
          'dns.port': port
        }
      }
    })

    this.addWrappedSubscriptions('apm:dns:resolve', 'dns.resolve', {
      tags: ({ context, args }) => {
        if (!isArgsValid(args, 2)) {
          context.noTrace = true
          return
        }

        const hostname = args[0]
        const rrtype = typeof args[1] === 'string' ? args[1] : rrtypeMap.get(context.wrapped) || 'A'
        return {
          'resource.name': `${rrtype} ${hostname}`,
          'dns.hostname': hostname,
          'dns.rrtype': rrtype
        }
      }
    })

    this.addWrappedSubscriptions('apm:dns:reverse', 'dns.reverse', {
      tags: ({ context, args }) => {
        if (!isArgsValid(args, 2)) {
          context.noTrace = true
          return
        }
        return { 'resource.name': args[0], 'dns.ip': args[0] }
      }
    })
  }
}

function isArgsValid (args, minLength) {
  if (args.length < minLength) return false
  if (typeof args[args.length - 1] !== 'function') return false

  return true
}

function patchResolveShorthands (prototype) {
  Object.keys(rrtypes)
    .filter(method => !!prototype[method])
    .forEach(method => {
      rrtypeMap.set(prototype[method], rrtypes[method])
      prototype[method] = wrap('apm:dns:resolve', prototype[method])
    })
}

module.exports = DNSPlugin
