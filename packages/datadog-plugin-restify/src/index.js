'use strict'

const { HTTP_ROUTE } = require('../../../ext/tags')
const RouterPlugin = require('../../datadog-plugin-router/src')
const web = require('../../dd-trace/src/plugins/util/web')

/** @type {import('../../dd-trace/src/http-resource').RouteReader} */
const selectedRoute = {
  readSamplingRoute (displayedRoute, context) {
    if (!context.config.DD_TRACE_OTEL_SEMANTICS_ENABLED) return displayedRoute ?? ''
    const route = context.span.context().getTag(HTTP_ROUTE)
    return typeof route === 'string' ? route : ''
  },
}

class RestifyPlugin extends RouterPlugin {
  static id = 'restify'

  constructor (...args) {
    super(...args)

    this.addSub('apm:restify:request:handle', ({ req }) => {
      this.setFramework(req, 'restify', this.config)
    })

    this.addSub('tracing:orchestrion:restify:routeMatch:start', ({ req, path }) => {
      const context = web.getContext(req)
      if (!context?.span) return
      const otel = context.config.DD_TRACE_OTEL_SEMANTICS_ENABLED
      const emptyRoute = !path || path === '*' || path === '/'
      let route = emptyRoute ? '' : path
      if (typeof route !== 'string') {
        if (otel) return
        route = route.toString()
      }
      web.setSamplingRouteReader(context, selectedRoute)
      if (route) web.setRoute(req, route)
    })

    this.addSub('apm:restify:middleware:enter', ({ req, routeSelected }) => {
      if (!routeSelected) return
      const context = web.getContext(req)
      if (context?.span && !context.samplingRouteReader) {
        web.setSamplingRouteReader(context, selectedRoute)
      }
    })
  }

  configure (config) {
    return super.configure({
      ...config,
      middleware: false, // not supported
    })
  }
}

module.exports = RestifyPlugin
