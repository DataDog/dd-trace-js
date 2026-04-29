'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')
const { createCallbackInstrumentor } = require('./helpers/callback-instrumentor')

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
  resolveSoa: 'SOA',
}

const rrtypeMap = new WeakMap()

addHook({ name: 'dns' }, dns => {
  const lookup = createCallbackInstrumentor('apm:dns:lookup', { captureResult: true })
  const lookupService = createCallbackInstrumentor('apm:dns:lookup_service', { captureResult: true })
  const resolve = createCallbackInstrumentor('apm:dns:resolve', { captureResult: true })
  const reverse = createCallbackInstrumentor('apm:dns:reverse', { captureResult: true })

  shimmer.wrap(dns, 'lookup', lookup(buildArgsContext()))
  shimmer.wrap(dns, 'lookupService', lookupService(buildArgsContext()))
  shimmer.wrap(dns, 'resolve', resolve(buildArgsContext()))
  shimmer.wrap(dns, 'reverse', reverse(buildArgsContext()))

  patchResolveShorthands(dns, resolve)

  if (dns.Resolver) {
    shimmer.wrap(dns.Resolver.prototype, 'resolve', resolve(buildArgsContext()))
    shimmer.wrap(dns.Resolver.prototype, 'reverse', reverse(buildArgsContext()))

    patchResolveShorthands(dns.Resolver.prototype, resolve)
  }

  return dns
})

function patchResolveShorthands (prototype, resolve) {
  for (const method of Object.keys(rrtypes)) {
    if (prototype[method]) {
      rrtypeMap.set(prototype[method], rrtypes[method])
      shimmer.wrap(prototype, method, resolve(buildArgsContext(rrtypes[method])))
    }
  }
}

function buildArgsContext (rrtype) {
  return function (_, args) {
    if (args.length < 2) return
    const captured = [...args]
    captured.pop() // remove the callback
    if (rrtype) {
      captured.push(rrtype)
    }
    return { args: captured }
  }
}
