'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing.js')
const tags = require('../../../ext/tags.js')
const { storage } = require('../../datadog-core')

class WSProducerPlugin extends TracingPlugin {
  static get id () { return 'websocket' }
  static get prefix () { return 'tracing:ws:send' }
  static get type () { return 'websocket' }
  static get kind () { return 'producer' }

  bindStart (ctx) {
    // const store = storage('legacy').getStore()
    // const childOf = store ? store.span : null
    // console.log('store', store, childOf)
    const span = this.startSpan(this.operationName(), {
      meta: {
        service: this.serviceName({ pluginConfig: this.config }),
        // 'resource.name': 'websocket ' + ,
        'span.type': 'websocket',
        'span.kind': 'producer'

      }

    }, true)
    // console.log('ctx', span.operationName())
    // span.addLink(ctx)
    // console.log(span)
    ctx.span = span
    ctx.currentStore = { span }

    return ctx.currentStore
  }

  end (ctx) {
    const store = storage('legacy').getStore()
    const childOf = store ? store.span : null
    console.log('store in producer', store, childOf)

    ctx.span.addLink(ctx.span._spanContext)
    // console.log(ctx.span)
    // console.log('in the end', ctx)
    // ctx.req.res = ctx.resStatus

    // ctx.span.setTag(HTTP_STATUS_CODE, ctx.req.res)
    // if (!ctx.span) return
    ctx.span.finish()
  }
}

module.exports = WSProducerPlugin
