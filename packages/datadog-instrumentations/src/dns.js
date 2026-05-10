'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')
const { createCallbackInstrumentor } = require('./helpers/callback-instrumentor')
const { createPromiseInstrumentor } = require('./helpers/promise-instrumentor')

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

addHook({ name: 'dns' }, dns => {
  patchApi(dns, createCallbackInstrumentor, buildCallbackArgsContext)

  // `dns.promises` (and `require('dns/promises')`) returns the same object; wrapping it from
  // here covers both access patterns when the user has required `dns` somewhere first.
  if (dns.promises) {
    patchApi(dns.promises, createPromiseInstrumentor, buildPromiseArgsContext)
  }

  return dns
})

function patchApi (api, instrumentorFactory, buildArgsContext) {
  const lookup = instrumentorFactory('apm:dns:lookup', { captureResult: true })
  const lookupService = instrumentorFactory('apm:dns:lookup_service', { captureResult: true })
  const resolve = instrumentorFactory('apm:dns:resolve', { captureResult: true })
  const reverse = instrumentorFactory('apm:dns:reverse', { captureResult: true })

  shimmer.wrap(api, 'lookup', lookup(buildArgsContext()))
  shimmer.wrap(api, 'lookupService', lookupService(buildArgsContext()))
  shimmer.wrap(api, 'resolve', resolve(buildArgsContext()))
  shimmer.wrap(api, 'reverse', reverse(buildArgsContext()))

  patchResolveShorthands(api, resolve, buildArgsContext)

  if (api.Resolver) {
    shimmer.wrap(api.Resolver.prototype, 'resolve', resolve(buildArgsContext()))
    shimmer.wrap(api.Resolver.prototype, 'reverse', reverse(buildArgsContext()))

    patchResolveShorthands(api.Resolver.prototype, resolve, buildArgsContext)
  }
}

function patchResolveShorthands (prototype, resolve, buildArgsContext) {
  for (const method of Object.keys(rrtypes)) {
    if (prototype[method]) {
      shimmer.wrap(prototype, method, resolve(buildArgsContext(rrtypes[method])))
    }
  }
}

function buildCallbackArgsContext (rrtype) {
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

function buildPromiseArgsContext (rrtype) {
  return function (_, args) {
    const captured = [...args]
    if (rrtype) {
      captured.push(rrtype)
    }
    return { args: captured }
  }
}
