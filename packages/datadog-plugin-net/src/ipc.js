'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class NetIPCPlugin extends ClientPlugin {
  static id = 'net'
  static operation = 'ipc'

  bindStart (ctx) {
    this.startSpan('ipc.connect', {
      service: this.config.service,
      resource: ctx.options.path,
      kind: 'client',
      meta: {
        'ipc.path': ctx.options.path
      }
    }, ctx)

    return ctx.currentStore
  }
}

module.exports = NetIPCPlugin
