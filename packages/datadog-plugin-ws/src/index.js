'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing.js')

class WSPlugin extends TracingPlugin {
  static get id () { return 'ws' }
  static get prefix () { return 'tracing:ws:client:connect' }
  static get type () { return 'websocket' }
  static get kind () { return 'consumer' }

  bindStart (message) {
    const req = message.req

    const options = {}
    const headers = Object.entries(req.headers)
    options.headers = Object.fromEntries(headers)
    options.method = req.method

    message.args = { options }

    const span = this.startSpan(this.operationName(), {
      meta: {
        service: this.serviceName({ pluginConfig: this.config }),
        'span.type': 'ws',
        'http.upgraded': 'websocket'

      }

    }, true)
    message.span = span
    // message.parentStore = store
    message.currentStore = { span }

    return message.currentStore
  }

  asyncStart (ctx) {
    console.log('ctx', ctx)
    ctx?.currentStore?.span.finish()
    return ctx.parentStore
  }
  // finish ({ req, res, span }) {
  //   console.log('arguments', arguments)
  //   if (!span) return
  //   console.log('span')
  //   span.finish()
  // }

  // asyncEnd (message) {
  //   console.log('async end')
  //   message.res = message.result
  //   return this.finish(message)
  // }
}

module.exports = WSPlugin
