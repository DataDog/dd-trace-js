'use strict'

const { entryTag } = require('../../dd-trace/src/code_origin')
const RouterPlugin = require('../../datadog-plugin-router/src')

const kCodeOriginForSpansTagsSym = Symbol('datadog.codeOriginForSpansTags')

class FastifyPlugin extends RouterPlugin {
  static get id () {
    return 'fastify'
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:fastify:request:handle', ({ req, routeConfig }) => {
      this.setFramework(req, 'fastify', this.config)
      const tags = routeConfig?.[kCodeOriginForSpansTagsSym]
      if (tags) this.setSpanTags(req, tags)
    })

    if (this._tracerConfig.codeOriginForSpansEnabled) {
      this.addSub('datadog:code-origin-for-spans', ({ routeOptions, topOfStackFunc }) => {
        if (!routeOptions.config) routeOptions.config = {}
        routeOptions.config[kCodeOriginForSpansTagsSym] = entryTag(topOfStackFunc)
      })
    }
  }
}

module.exports = FastifyPlugin
