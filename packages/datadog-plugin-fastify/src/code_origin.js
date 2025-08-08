'use strict'

const { entryTags } = require('../../datadog-code-origin')
const WebPlugin = require('../../datadog-plugin-web/src')

const kCodeOriginForSpansTagsSym = Symbol('datadog.codeOriginForSpansTags')

class FastifyCodeOriginForSpansPlugin extends WebPlugin {
  static id = 'fastify'

  constructor (...args) {
    super(...args)

    this.addSub('apm:fastify:request:handle', ({ req, routeConfig }) => {
      const tags = routeConfig?.[kCodeOriginForSpansTagsSym]
      if (!tags) return
      const context = this.getContext(req)
      context.span?.addTags(tags)
    })

    this.addSub('apm:fastify:route:added', ({ routeOptions, onRoute }) => {
      if (!routeOptions.config) routeOptions.config = {}
      routeOptions.config[kCodeOriginForSpansTagsSym] = entryTags(onRoute)
    })
  }
}

module.exports = FastifyCodeOriginForSpansPlugin
