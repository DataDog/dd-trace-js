'use strict'

const { channel, addHook, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

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
const names = ['dns', 'node:dns']

addHook({ name: names }, dns => {
  shimmer.wrap(dns, 'lookup', fn => wrap('apm:dns:lookup', fn, 2))
  shimmer.wrap(dns, 'lookupService', fn => wrap('apm:dns:lookup_service', fn, 2))
  shimmer.wrap(dns, 'resolve', fn => wrap('apm:dns:resolve', fn, 2))
  shimmer.wrap(dns, 'reverse', fn => wrap('apm:dns:reverse', fn, 2))

  patchResolveShorthands(dns)

  if (dns.Resolver) {
    shimmer.wrap(dns.Resolver.prototype, 'resolve', fn => wrap('apm:dns:resolve', fn, 2))
    shimmer.wrap(dns.Resolver.prototype, 'reverse', fn => wrap('apm:dns:reverse', fn, 2))

    patchResolveShorthands(dns.Resolver.prototype)
  }

  return dns
})

function patchResolveShorthands (prototype) {
  Object.keys(rrtypes)
    .filter(method => !!prototype[method])
    .forEach(method => {
      rrtypeMap.set(prototype[method], rrtypes[method])
      shimmer.wrap(prototype, method, fn => wrap('apm:dns:resolve', fn, 2, rrtypes[method]))
    })
}

function wrap (prefix, fn, expectedArgs, rrtype) {
  const startCh = channel(prefix + ':start')
  const finishCh = channel(prefix + ':finish')
  const errorCh = channel(prefix + ':error')

  const wrapped = function () {
    const cb = AsyncResource.bind(arguments[arguments.length - 1])
    if (
      !startCh.hasSubscribers ||
      arguments.length < expectedArgs ||
      typeof cb !== 'function'
    ) {
      return fn.apply(this, arguments)
    }

    const startArgs = Array.from(arguments)
    startArgs.pop() // gets rid of the callback
    if (rrtype) {
      startArgs.push(rrtype)
    }

    const asyncResource = new AsyncResource('bound-anonymous-fn')
    return asyncResource.runInAsyncScope(() => {
      startCh.publish(startArgs)

      arguments[arguments.length - 1] = shimmer.wrapFunction(cb, cb => asyncResource.bind(function (error, result) {
        if (error) {
          errorCh.publish(error)
        }
        finishCh.publish(result)
        cb.apply(this, arguments)
      }))

      try {
        return fn.apply(this, arguments)
      // TODO deal with promise versions when we support `dns/promises`
      } catch (error) {
        error.stack // trigger getting the stack at the original throwing point
        errorCh.publish(error)

        throw error
      }
    })
  }

  return wrapped
}
