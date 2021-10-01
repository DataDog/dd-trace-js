'use strict'

const dc = require('diagnostics_channel')
const { AsyncResource } = require('async_hooks')

const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const tx = require('../../dd-trace/src/plugins/util/tx')

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

function createWrapLookup (config) {
  return function wrapLookup (lookup) {
    return dcWrap(config, 'apm:dns:lookup', lookup)
  }
}
dcSub('apm:dns:lookup', 'dns.lookup', {
  tags: ({ context, args }) => {
    if (!isArgsValid(args, 2)) {
      context.noTrace = true
      return
    }
    return { 'resource.name': args[0], 'dns.hostname': args[0] }
  },
  asyncEnd: ({ context, result }) => context.span.setTag('dns.address', result[0])
})

function createWrapLookupService (config) {
  return function wrapLookupService (lookupService) {
    return dcWrap(config, 'apm:dns:lookup_service', lookupService)
  }
}
dcSub('apm:dns:lookup_service', 'dns.lookup_service', {
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

function createWrapResolve (config) {
  return function wrapResolve (resolve) {
    return dcWrap(config, 'apm:dns:resolve', resolve)
  }
}
dcSub('apm:dns:resolve', 'dns.resolve', {
  tags: ({ context, config, args }) => {
    if (!isArgsValid(args, 2)) {
      context.noTrace = true
      return
    }

    const hostname = args[0]
    const rrtype = typeof args[1] === 'string' ? args[1] : config.rrtype || 'A'
    return {
      'resource.name': `${rrtype} ${hostname}`,
      'dns.hostname': hostname,
      'dns.rrtype': rrtype
    }
  }
})

function createWrapResolver (config, rrtype) {
  return function wrapResolve (resolve) {
    config = Object.assign({}, config, { rrtype })
    return dcWrap(config, 'apm:dns:resolve', resolve)
  }
}

function createWrapReverse (config) {
  return function wrapReverse (reverse) {
    return dcWrap(config, 'apm:dns:reverse', reverse)
  }
}

dcSub('apm:dns:reverse', 'dns.reverse', {
  tags: ({ context, args }) => {
    if (!isArgsValid(args, 2)) {
      context.noTrace = true
      return
    }
    return { 'resource.name': args[0], 'dns.ip': args[0] }
  }
})

function startSpan (config, operation, tags) {
  const childOf = tracer().scope().active()
  const span = tracer().startSpan(operation, {
    childOf,
    tags: Object.assign({
      'service.name': config.service || tracer()._service,
      'span.kind': 'client'
    }, tags)
  })

  analyticsSampler.sample(span, config.measured)

  return span
}

function isArgsValid (args, minLength) {
  if (args.length < minLength) return false
  if (typeof args[args.length - 1] !== 'function') return false

  return true
}

function patchResolveShorthands (config, shim, prototype) {
  Object.keys(rrtypes)
    .filter(method => !!prototype[method])
    .forEach(method => {
      shim.wrap(prototype, method, createWrapResolver(config, rrtypes[method]))
    })
}

function unpatchResolveShorthands (shim, prototype) {
  Object.keys(rrtypes)
    .filter(method => !!prototype[method])
    .forEach(method => {
      shim.unwrap(prototype, method)
    })
}

function tracer () {
  return global._ddtrace._tracer
}

function channel (name) {
  if (!global._ddtraceChannels) {
    global._ddtraceChannels = new Set()
  }
  const ch = dc.channel(name)
  global._ddtraceChannels.add(ch)
  return ch
}

function dcWrap (config, prefix, fn) {
  const startCh = channel(prefix + ':start')
  const endCh = channel(prefix + ':end')
  const asyncEndCh = channel(prefix + ':async-end')
  const errorCh = channel(prefix + ':error')

  return function () {
    const context = {}
    const cb = AsyncResource.bind(arguments[arguments.length - 1])

    startCh.publish({ context, config, args: arguments, thisObj: this })

    if (typeof cb === 'function') {
      arguments[arguments.length - 1] = function (error, ...result) {
        if (error) {
          errorCh.publish({ context, error, type: 'callback' })
        } else {
          if (result.length === 1) {
            result = result[0]
          }
          asyncEndCh.publish({ context, result, type: 'callback' })
        }
        cb.call(this, error, ...result)
      }
    }

    let result
    try {
      result = fn.apply(this, arguments)

      if (result && typeof result.then === 'function') {
        result.then(
          result => asyncEndCh.publish({ context, result, type: 'promise' }),
          error => errorCh.publish({ context, error, type: 'reject' })
        )
      }
    } catch (error) {
      error.stack // trigger getting the stack at the original throwing point
      errorCh.publish({ context, error, type: 'throw' })

      throw error
    } finally {
      endCh.publish({ context, result })
    }
  }
}

function dcSub (prefix, name, hooks = {}) {
  hooks = Object.assign({
    tags: () => ({}),
    asyncEnd: () => {}
  }, hooks)
  channel(prefix + ':start').subscribe(({ context, config, args }) => {
    const tags = hooks.tags({ context, config, args })
    if (context.noTrace) return
    const span = startSpan(config, name, tags)
    context.parent = tracer().scope()._activeResource()
    context.span = span
    tracer().scope()._enter(span, context.parent)
  })
  channel(prefix + ':end').subscribe(({ context }) => {
    if (context.noTrace) return
    tracer().scope()._exit(context.parent)
  })
  channel(prefix + ':async-end').subscribe(({ context, result }) => {
    if (context.noTrace) return
    hooks.asyncEnd({ context, result })
    context.span.finish()
  })
  channel(prefix + ':error').subscribe(({ context, error }) => {
    if (context.noTrace) return
    context.span.addError(error)
    context.span.finish()
  })
}

module.exports = [
  {
    name: 'dns',
    patch (dns, tracer, config) {
      this.wrap(dns, 'lookup', createWrapLookup(config))
      this.wrap(dns, 'lookupService', createWrapLookupService(config))
      this.wrap(dns, 'resolve', createWrapResolve(config))
      this.wrap(dns, 'reverse', createWrapReverse(config))

      patchResolveShorthands(config, this, dns)

      if (dns.Resolver) {
        this.wrap(dns.Resolver.prototype, 'resolve', createWrapResolve(config))
        this.wrap(dns.Resolver.prototype, 'reverse', createWrapReverse(config))

        patchResolveShorthands(config, this, dns.Resolver.prototype)
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
