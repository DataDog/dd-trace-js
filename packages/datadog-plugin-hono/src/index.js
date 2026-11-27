'use strict'

const RouterPlugin = require('../../datadog-plugin-router/src')
const web = require('../../dd-trace/src/plugins/util/web')

/** @type {import('../../dd-trace/src/http-resource').RouteReader} */
const pendingRoute = { readSamplingRoute: () => false }
/** @type {import('../../dd-trace/src/http-resource').RouteReader} */
const selectedRoute = { readSamplingRoute: route => route }

class HonoPlugin extends RouterPlugin {
  static id = 'hono'
  /** @param {import('../../dd-trace/src/http-resource').RouteReader | undefined} reader */
  static shouldPublishMiddlewareRoute (reader) {
    return reader !== pendingRoute && reader !== selectedRoute
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:hono:request:handle', ({ req }) => {
      this.setFramework(req, 'hono', this.config)
      const context = web.getContext(req)
      if (context?.span && !context.samplingRouteReader) {
        web.setSamplingRouteReader(context, pendingRoute)
      }
    })

    this.addSub('apm:hono:request:route', ({ req, route }) => {
      const context = web.getContext(req)
      if (!context?.span) return
      web.setSamplingRouteReader(context, selectedRoute)
      web.setRoute(req, route)
    })

    this.addSub('apm:hono:request:error', ({ req, error }) => {
      web.addError(req, error)
    })
  }
}

module.exports = HonoPlugin
