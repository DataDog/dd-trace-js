'use strict'

const { storage } = require('../../datadog-core')
const ClientPlugin = require('../../dd-trace/src/plugins/client')

class NetIPCPlugin extends ClientPlugin {
  static get id () { return 'net' }
  static get operation () { return 'ipc' }

  bindStart (ctx) {
    const store = storage('legacy').getStore()
    const childOf = store ? store.span : null

    const span = this.startSpan('ipc.connect', {
      childOf,
      service: this.config.service,
      resource: ctx.options.path,
      kind: 'client',
      meta: {
        'ipc.path': ctx.options.path
      }
    }, false)

    ctx.parentStore = store
    ctx.currentStore = { ...store, span }

    return ctx.currentStore
  }
}

module.exports = NetIPCPlugin
