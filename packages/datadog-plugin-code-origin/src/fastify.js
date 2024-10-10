'use strict'

const { entryTag } = require('./tags')
const web = require('../../dd-trace/src/plugins/util/web')

const kCodeOriginForSpansTagsSym = Symbol('datadog.codeOriginForSpansTags')

module.exports = function (plugin) {
  plugin.addSub('apm:fastify:request:handle', ({ req, routeConfig }) => {
    const tags = routeConfig?.[kCodeOriginForSpansTagsSym]
    if (!tags) return
    const context = web.getContext(req)
    context.span?.addTags(tags)
  })

  plugin.addSub('apm:fastify:route:added', ({ routeOptions, onRoute }) => {
    if (!routeOptions.config) routeOptions.config = {}
    routeOptions.config[kCodeOriginForSpansTagsSym] = entryTag(onRoute)
  })
}
