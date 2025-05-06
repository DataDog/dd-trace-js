'use strict'

const { storage } = require('../../datadog-core')
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
    const store = storage('legacy').getStore()
    const childOf = store ? store.span : null

    const span = this.startSpan('tcp.connect', {
      childOf,
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
    }, false)

    ctx.parentStore = store
    ctx.currentStore = { ...store, span }

    return ctx.currentStore
  }
}

module.exports = NetTCPPlugin
