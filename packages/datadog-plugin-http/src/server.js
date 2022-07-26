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
      const span = web.startSpan(this.tracer, this.config, req, res, 'web.request')

      this.enter(span, { ...store, req })

      const context = web.getContext(req)

      if (!context.instrumented) {
        context.res.writeHead = web.wrapWriteHead(context)
        context.instrumented = true
      }

      if (incomingHttpRequestStart.hasSubscribers) {
        incomingHttpRequestStart.publish({ req, res })
      }
    })

    this.addSub('apm:http:server:request:error', (error) => {
      web.addError(error)
    })

    this.addSub('apm:http:server:request:finish', ({ req }) => {
      const context = web.getContext(req)

      if (!context || !context.res) return // Not created by a http.Server instance.

      web.finishAll(context)
    })
  }

  configure (config) {
    return super.configure(web.normalizeConfig(config))
  }
}

module.exports = HttpServerPlugin
