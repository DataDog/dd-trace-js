'use strict'

const { rrtypeMap } = require('../../datadog-instrumentations/src/dns')
const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')

// // TODO oops! we need to properly use this
// const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

class DNSPlugin extends Plugin {
  static get name () {
    return 'dns'
  }

  get kind () {
    return 'client'
  }

  addSubs (func, start, asyncEnd) {
    this.addSub(`apm:dns:${func}:start`, start)
    this.addSub(`apm:dns:${func}:end`, this.exit.bind(this))
    this.addSub(`apm:dns:${func}:error`, errorHandler)
    this.addSub(`apm:dns:${func}:async-end`, asyncEnd || defaultAsyncEndHandler)
  }

  constructor (config) {
    super(config)
    this.addSubs('lookup', context => {
      const { args } = context
      if (!isArgsValid(args, 2)) {
        context.noTrace = true
        return
      }
      this.startSpanAndEnter('dns.lookup', {
        'resource.name': args[0],
        'dns.hostname': args[0]
      })
    }, ({ result }) => {
      const store = storage.getStore()
      if (!store) return // TODO why do we have a no-store scenario??
      store.span.setTag('dns.address', result[0])
      store.span.finish()
    })

    this.addSubs('lookup_service', context => {
      const { args } = context
      if (!isArgsValid(args, 3)) {
        context.noTrace = true
        return
      }
      const [address, port] = args
      this.startSpanAndEnter('dns.lookup_service', {
        'resource.name': `${address}:${port}`,
        'dns.address': address,
        'dns.port': port
      })
    })

    this.addSubs('resolve', context => {
      const { args } = context
      if (!isArgsValid(args, 2)) {
        context.noTrace = true
        return
      }

      const hostname = args[0]
      const rrtype = typeof args[1] === 'string' ? args[1] : rrtypeMap.get(context.wrapped) || 'A'
      this.startSpanAndEnter('dns.resolve', {
        'resource.name': `${rrtype} ${hostname}`,
        'dns.hostname': hostname,
        'dns.rrtype': rrtype
      })
    })

    this.addSubs('reverse', context => {
      const { args } = context
      if (!isArgsValid(args, 2)) {
        context.noTrace = true
        return
      }

      this.startSpanAndEnter('dns.reverse', { 'resource.name': args[0], 'dns.ip': args[0] })
    })
  }
}

function isArgsValid (args, minLength) {
  if (args.length < minLength) return false
  if (typeof args[args.length - 1] !== 'function') return false

  return true
}

function defaultAsyncEndHandler () {
  storage.getStore().span.finish()
}

function errorHandler (error) {
  const { span } = storage.getStore()
  span.addError(error)
  span.finish()
}

module.exports = DNSPlugin
