'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const ClientPlugin = require('../../dd-trace/src/plugins/client')

class NetTCPPlugin extends ClientPlugin {
  static get id () { return 'net' }
  static get operation () { return 'tcp' }
  static get peerServicePrecursors () { return ['queuename'] }


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

    const parentSpan = this.tracer.scope().active();

    const span = this.startSpan('tcp.connect', {
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
        [CLIENT_PORT_KEY]: port
      }
    })

    if (parentSpan && parentSpan.context()._tags && parentSpan.context()._tags['queuename']) {
      span.setTag('queuename', parentSpan.context()._tags['queuename']);
    }
  }
}

module.exports = NetTCPPlugin
