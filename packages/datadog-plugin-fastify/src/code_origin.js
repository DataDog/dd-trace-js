'use strict'

const { entryTags } = require('../../datadog-code-origin')
const Plugin = require('../../dd-trace/src/plugins/plugin')
const web = require('../../dd-trace/src/plugins/util/web')

class FastifyCodeOriginForSpansPlugin extends Plugin {
  static get id () {
    return 'fastify'
  }

  constructor (...args) {
    super(...args)

    const routeTags = new WeakMap()

    this.addSub('apm:fastify:request:handle', ({ req, routeConfig }) => {
      const tags = routeTags.get(routeConfig)
      if (!tags) return
      web.getContext(req).span?.addTags(tags)
    })

    this.addSub('apm:fastify:route:added', ({ routeOptions, onRoute }) => {
      if (!routeOptions.config) routeOptions.config = {}
      if (routeTags.has(routeOptions.config)) return
      routeTags.set(routeOptions.config, entryTags(onRoute))
    })
  }
}

module.exports = FastifyCodeOriginForSpansPlugin
