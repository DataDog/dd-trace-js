'use strict'

const { AsyncResource } = require('async_hooks')
const { channel, addHook } = require('../../dd-trace/src/plugins/instrument')

const empty = {}

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

function wrap (prefix, fn) {
  const startCh = channel(prefix + ':start')
  const endCh = channel(prefix + ':end')
  const asyncEndCh = channel(prefix + ':async-end')
  const errorCh = channel(prefix + ':error')

  const wrapped = function () {
    const cb = AsyncResource.bind(arguments[arguments.length - 1])
    const context = { wrapped: fn, args: arguments }

    startCh.publish(context)
    if (context.noTrace) {
      return fn.apply(this, arguments)
    }

    arguments[arguments.length - 1] = function (error, ...result) {
      if (error) {
        errorCh.publish(error)
      } else {
        asyncEndCh.publish({ result })
      }
      cb.call(this, error, ...result)
    }

    try {
      return fn.apply(this, arguments)
      // TODO deal with promise versions when we support `dns/promises`
    } catch (error) {
      error.stack // trigger getting the stack at the original throwing point
      errorCh.publish(error)

      throw error
    } finally {
      endCh.publish(empty)
    }
  }

  Reflect.ownKeys(fn).forEach(key => {
    Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(fn, key))
  })

  return wrapped
}
