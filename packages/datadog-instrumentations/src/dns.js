'use strict'

const { wrap, addHook } = require('../../dd-trace/src/plugins/instrument')

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
  dns.lookupService = wrap('apm:dns:lookup_service', dns.lookupService)
  dns.resolve = wrap('apm:dns:resolve', dns.resolve)
  dns.reverse = wrap('apm:dns:reverse', dns.reverse)

  patchResolveShorthands(dns)

  if (dns.Resolver) {
    dns.Resolver.prototype.resolve = wrap('apm:dns:resolve', dns.Resolver.prototype.resolve)
    dns.Resolver.prototype.reverse = wrap('apm:dns:reverse', dns.Resolver.prototype.reverse)

    patchResolveShorthands(dns.Resolver.prototype)
  }

  return dns
})

function patchResolveShorthands (prototype) {
  Object.keys(rrtypes)
    .filter(method => !!prototype[method])
    .forEach(method => {
      rrtypeMap.set(prototype[method], rrtypes[method])
      prototype[method] = wrap('apm:dns:resolve', prototype[method])
    })
}

// These modules normally don't have exports, but in this case, we want to use
// the rrtypeMap in the plugin, so we'll export it.
// TODO find some better common place for it, or retain a copy here and in the plugin.
module.exports = { rrtypeMap }
