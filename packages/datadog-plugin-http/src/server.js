'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const web = require('../../dd-trace/src/plugins/util/web')
const { incomingHttpRequestStart } = require('../../dd-trace/src/appsec/gateway/channels')

class HttpServerPlugin extends Plugin {
  static get name () {
    return 'http'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:http:server:request:start', ({ req, res }) => {
      const store = storage.getStore()
      const span = web.startSpan(this.tracer, this.config, req, res, 'http.request')

      this.enter(span, store)

      const context = web.getContext(req)

      if (!context.instrumented) {
        context.res.writeHead = web.wrapWriteHead(context)
        context.instrumented = true
      }

      if (incomingHttpRequestStart.hasSubscribers) {
        incomingHttpRequestStart.publish({ req, res })
      }
    })

    this.addSub('apm:http:server:request:end', () => {
      this.exit()
    })

    this.addSub('apm:http:server:request:error', (error) => {
      const span = storage.getStore().span
      span.addTags({
        'error.type': error.name,
        'error.msg': error.message,
        'error.stack': error.stack
      })
    })

    this.addSub('apm:http:server:request:async-end', ({ req }) => {
      const context = web.getContext(req)

      if (!context) return // Not created by a http.Server instance.

      web.wrapRes(context, context.req, context.res, context.res.end)()
    })
  }

  configure (config) {
    return super.configure(web.normalizeConfig(config))
  }
}

module.exports = HttpServerPlugin
