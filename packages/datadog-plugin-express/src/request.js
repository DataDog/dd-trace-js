'use strict'

const { storage } = require('../../datadog-core')
const web = require('../../dd-trace/src/plugins/util/web')
const tags = require('../../../ext/tags')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const SERVICE_NAME = tags.SERVICE_NAME
const MANUAL_DROP = tags.MANUAL_DROP
const Plugin = require('../../dd-trace/src/plugins/plugin')

class ExpressRequestPlugin extends Plugin {
  static get name () {
    return 'express'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:express:request:start', ({ req, res }) => {
      const store = storage.getStore()
      this.config = web.normalizeConfig(this.config)

      const span = web.startSpan(this.tracer, this.config, req, res, 'express.request')

      if (!this.config.filter(req.url)) {
        span.setTag(MANUAL_DROP, true)
      }

      if (this.config.service) {
        span.setTag(SERVICE_NAME, this.config.service)
      }

      analyticsSampler.sample(span, this.config.measured, true)
      this.enter(span, store)

      const context = web.getContext(req)

      if (!context.instrumented) {
        context.res.writeHead = web.wrapWriteHead(context)
        context.instrumented = true
      }
    })

    this.addSub('apm:express:request:error', (error) => {
      const span = storage.getStore().span
      span.addTags({
        'error.type': error.name,
        'error.msg': error.message,
        'error.stack': error.stack
      })
    })

    this.addSub('apm:express:request:finish', ({ req }) => {
      const context = web.getContext(req)
      web.wrapRes(context, context.req, context.res, context.res.end)()
    })
  }
}

module.exports = ExpressRequestPlugin
