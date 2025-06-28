'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing.js')

class WSReceiverPlugin extends TracingPlugin {
  static get id () { return 'websocket' }
  // static get prefix () { return 'tracing:ws:send' }
  static get type () { return 'websocket' }
  static get kind () { return 'producer' }

  bindStart (ctx) {
    // console.log('ctx in receiver', ctx)

    const span = this.startSpan(this.operationName(), {
      meta: {
        service: this.serviceName({ pluginConfig: this.config }),
        // 'resource.name': 'websocket ' + ,
        'span.type': 'ws',
        'span.kind': 'receiver'

      }

    }, true)

    ctx.span = span
    ctx.currentStore = { span }

    return ctx.currentStore
  }

  end (ctx) {
    // console.log('ctx in end', ctx)

    ctx.span.finish()
  }
}

module.exports = WSReceiverPlugin
