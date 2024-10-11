'use strict'

const { entryTag } = require('./lib/tags')
const CodeOriginForSpansPlugin = require('./index')
const web = require('../../dd-trace/src/plugins/util/web')

const kCodeOriginForSpansTagsSym = Symbol('datadog.codeOriginForSpansTags')

class FastifyCodeOriginForSpansPlugin extends CodeOriginForSpansPlugin {
  static get id () {
    return 'fastify-code-origin-for-spans'
  }

  instrument () {
    this.addSub('apm:fastify:request:handle', ({ req, routeConfig }) => {
      const tags = routeConfig?.[kCodeOriginForSpansTagsSym]
      if (!tags) return
      const context = web.getContext(req)
      context.span?.addTags(tags)
    })

    this.addSub('apm:fastify:route:added', ({ routeOptions, onRoute }) => {
      if (!routeOptions.config) routeOptions.config = {}
      routeOptions.config[kCodeOriginForSpansTagsSym] = entryTag(onRoute)
    })
  }
}

module.exports = FastifyCodeOriginForSpansPlugin
