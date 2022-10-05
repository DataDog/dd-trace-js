'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class NetTCPPlugin extends ClientPlugin {
  static get name () { return 'net' }
  static get operation () { return 'tcp' }

  constructor (...args) {
    super(...args)

    this.addTraceSub('connection', ({ socket }) => {
      const span = this.activeSpan

      span.addTags({
        'tcp.local.address': socket.localAddress,
        'tcp.local.port': socket.localPort
      })
    })
  }

  start ({ options }) {
    const host = options.host || 'localhost'
    const port = options.port || 0
    const family = options.family || 4

    this.startSpan('tcp.connect', {
      service: this.config.service,
      resource: [host, port].filter(val => val).join(':'),
      kind: 'client',
      meta: {
        'tcp.remote.host': host,
        'tcp.family': `IPv${family}`,
        'tcp.local.address': '',
        'out.host': host
      },
      metrics: {
        'tcp.remote.port': port,
        'tcp.local.port': 0,
        'out.port': port
      }
    })
  }
}

module.exports = NetTCPPlugin
