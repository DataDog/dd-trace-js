'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')
const { resolveHostDetails } = require('../../dd-trace/src/util')

class NetTCPPlugin extends ClientPlugin {
  static get name () { return 'net' }
  static get operation () { return 'tcp' }

  constructor (...args) {
    super(...args)

    this.addTraceSub('connection', ({ socket }) => {
      const span = this.activeSpan

      span.addTags({
        'tcp.local.address': socket.localAddress,
        'tcp.local.port': socket.localPort,
        'network.client.ip': socket.localAddress,
        'network.client.port': socket.localPort,
        'network.client.name': 'localhost',
        'network.client.transport': 'ip_tcp'
      })
    })
  }

  start ({ options }) {
    const host = options.host || 'localhost'
    const port = options.port || 0
    const family = options.family || 4

    const networkingDestinationHostDetails = resolveHostDetails(host)
    this.startSpan('tcp.connect', {
      service: this.config.service,
      resource: [host, port].filter(val => val).join(':'),
      kind: 'client',
      meta: {
        'tcp.remote.host': host,
        'tcp.family': `IPv${family}`,
        'tcp.local.address': '',
        ...networkingDestinationHostDetails,
        'network.destination.transport': 'ip_tcp'
      },
      metrics: {
        'tcp.remote.port': port,
        'tcp.local.port': 0,
        'network.client.port': 0,
        'network.destination.port': port
      }
    })
  }
}

module.exports = NetTCPPlugin
