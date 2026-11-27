'use strict'

const RouterPlugin = require('../../datadog-plugin-router/src')
const web = require('../../dd-trace/src/plugins/util/web')

/** @type {import('../../dd-trace/src/http-resource').RouteReader} */
const explicitRoute = { readSamplingRoute () {} }

class ExpressTracingPlugin extends RouterPlugin {
  static id = 'express'

  constructor (...args) {
    super(...args)

    this.addSub('apm:express:request:handle', ({ req }) => {
      this.setFramework(req, 'express', this.config)
      const context = web.getContext(req)
      if (context?.span && !context.samplingRouteReader) {
        web.setSamplingRouteReader(context, explicitRoute)
      }
    })
  }
}

module.exports = ExpressTracingPlugin
