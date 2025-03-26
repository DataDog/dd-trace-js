'use strict'

const { entryTags } = require('../../datadog-code-origin')
const Plugin = require('../../dd-trace/src/plugins/plugin')
const web = require('../../dd-trace/src/plugins/util/web')

const kCodeOriginForSpansTagsSym = Symbol('datadog.codeOriginForSpansTags')

class FastifyCodeOriginForSpansPlugin extends Plugin {
  static get id () {
    return 'fastify'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:fastify:request:handle', ({ req, routeConfig }) => {
      const tags = routeConfig?.[kCodeOriginForSpansTagsSym]
      if (!tags) return
      const context = web.getContext(req)
      context.span?.addTags(tags)
    })

    this.addSub('apm:fastify:route:added', ({ routeOptions, onRoute }) => {
      if (!routeOptions.config) routeOptions.config = {}
      routeOptions.config[kCodeOriginForSpansTagsSym] = entryTags(onRoute)
    })
  }
}

module.exports = FastifyCodeOriginForSpansPlugin
