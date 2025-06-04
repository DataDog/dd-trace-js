'use strict'

const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const ClientPlugin = require('../../dd-trace/src/plugins/client')

class NetTCPPlugin extends ClientPlugin {
  static get id () { return 'net' }
  static get operation () { return 'tcp' }

  constructor (...args) {
    super(...args)

    this.addTraceBind('ready', (ctx) => {
      return ctx.parentStore
    })

    this.addTraceSub('connection', (ctx) => {
      const span = ctx.currentStore.span

      span.addTags({
        'tcp.local.address': ctx.socket.localAddress,
        'tcp.local.port': ctx.socket.localPort
      })
    })
  }

  bindStart (ctx) {
    const host = ctx.options.host || 'localhost'
    const port = ctx.options.port || 0
    const family = ctx.options.family || 4

    this.startSpan('tcp.connect', {
      service: this.config.service,
      resource: [host, port].filter(Boolean).join(':'),
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
    }, ctx)

    return ctx.currentStore
  }
}

module.exports = NetTCPPlugin
