'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const web = require('../../dd-trace/src/plugins/util/web')
const tags = require('../../../ext/tags')
const RESOURCE_NAME = tags.RESOURCE_NAME

class RouterPlugin extends Plugin {
  static get name () {
    return 'router'
  }

  constructor (...args) {
    super(...args)

    this.addSub(`apm:router:middleware:start`, ({ req, handle }) => {
      if (!web.active(req)) return undefined

      const store = storage.getStore()

      const context = web.getContext(req)
      const tracer = context.tracer
      const childOf = web.active(req)
      const config = context.config

      if (config.middleware === false) {
        return undefined
      }

      const span = tracer.startSpan('express.middleware', { childOf })

      analyticsSampler.sample(span, config.measured)

      span.addTags({
        [RESOURCE_NAME]: handle._name || handle.name || '<anonymous>'
      })

      context.middleware.push(span)

      this.enter(span, store)
    })

    this.addSub(`apm:router:middleware:enter`, ({ req, context }) => {
      web.patch(req)
      if (context) {
        web.beforeEnd(req, () => {
          web.enterRoute(req, context.route)
        })
      }
    })

    this.addSub(`apm:router:middleware:error`, ({ error }) => {
      const span = storage.getStore().span
      span.addTags({
        'error.type': error.name,
        'error.msg': error.message,
        'error.stack': error.stack
      })
    })

    this.addSub(`apm:router:middleware:finish`, ({ req, error }) => {
      web.finish(req, error)
    })
  }
}

module.exports = RouterPlugin
