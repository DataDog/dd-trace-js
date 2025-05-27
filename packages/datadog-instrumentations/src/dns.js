'use strict'

const { channel, addHook } = require('./helpers/instrument')
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
  for (const method of Object.keys(rrtypes)) {
    if (prototype[method]) {
      rrtypeMap.set(prototype[method], rrtypes[method])
      shimmer.wrap(prototype, method, fn => wrap('apm:dns:resolve', fn, 2, rrtypes[method]))
    }
  }
}

function wrap (prefix, fn, expectedArgs, rrtype) {
  const startCh = channel(prefix + ':start')
  const finishCh = channel(prefix + ':finish')
  const errorCh = channel(prefix + ':error')

  const wrapped = function () {
    const cb = arguments[arguments.length - 1]
    if (
      !startCh.hasSubscribers ||
      arguments.length < expectedArgs ||
      typeof cb !== 'function'
    ) {
      return fn.apply(this, arguments)
    }

    const args = [...arguments]
    args.pop() // gets rid of the callback
    if (rrtype) {
      args.push(rrtype)
    }

    const ctx = { args }

    return startCh.runStores(ctx, () => {
      arguments[arguments.length - 1] = shimmer.wrapFunction(cb, cb => function (error, result, ...args) {
        if (error) {
          ctx.error = error
          errorCh.publish(ctx)
        }

        ctx.result = result
        finishCh.runStores(ctx, cb, this, error, result, ...args)
      })

      try {
        return fn.apply(this, arguments)
      // TODO deal with promise versions when we support `dns/promises`
      } catch (error) {
        error.stack // trigger getting the stack at the original throwing point
        ctx.error = error
        errorCh.publish(ctx)

        throw error
      }
    })
  }

  return wrapped
}
