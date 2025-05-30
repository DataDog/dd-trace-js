'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class NetIPCPlugin extends ClientPlugin {
  static get id () { return 'net' }
  static get operation () { return 'ipc' }

  start (ctx) {
    this.startSpan('ipc.connect', {
      service: this.config.service,
      resource: ctx.options.path,
      kind: 'client',
      meta: {
        'ipc.path': ctx.options.path
      }
    }, ctx)
  }
}

module.exports = NetIPCPlugin
