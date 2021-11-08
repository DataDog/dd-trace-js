'use strict'

const { rrtypeMap } = require('../../datadog-instrumentations/src/dns')
const Plugin = require('../../dd-trace/src/plugins/plugin')

// // TODO oops! we need to properly use this
// const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

class DNSPlugin extends Plugin {
  static get name () {
    return 'dns'
  }

  static get kind () {
    return 'client'
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

module.exports = DNSPlugin
