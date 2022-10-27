'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class NetIPCPlugin extends ClientPlugin {
  static get name () { return 'net' }
  static get operation () { return 'ipc' }

  start ({ options }) {
    this.startSpan('ipc.connect', {
      service: this.config.service,
      resource: options.path,
      kind: 'client',
      meta: {
        'ipc.path': options.path
      }
    })
  }
}

module.exports = NetIPCPlugin
