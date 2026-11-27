'use strict'

const { storage } = require('../../datadog-core')
const RouterPlugin = require('../../datadog-plugin-router/src')
const web = require('../../dd-trace/src/plugins/util/web')

/** @type {import('../../dd-trace/src/http-resource').RouteReader} */
const selectedRoute = { readSamplingRoute: route => route }

class HapiPlugin extends RouterPlugin {
  static id = 'hapi'

  constructor (...args) {
    super(...args)

    this._requestSpans = new WeakMap()

    this.addSub('apm:hapi:request:handle', ({ req }) => {
      const store = storage('legacy').getStore()
      const span = store && store.span

      this.setFramework(req, 'hapi', this.config)
      this._requestSpans.set(req, span)
    })

    this.addSub('apm:hapi:request:route', ({ req, route }) => {
      const context = web.getContext(req)
      if (context?.samplingRouteReader !== selectedRoute || context.config.DD_TRACE_OTEL_SEMANTICS_ENABLED ||
          context.paths[0] !== route) {
        web.setRoute(req, route)
      }
    })

    for (const name of ['hapi', '@hapi/hapi']) {
      this.addSub(`tracing:orchestrion:${name}:routeLookup:end`, ({ req, route }) => {
        const context = web.getContext(req)
        if (!context?.span) return
        web.setSamplingRouteReader(context, selectedRoute)
        web.setRoute(req, route)
      })
    }

    this.addSub('apm:hapi:request:error', error => {
      if (!error || !error.isBoom || !this.config.validateStatus(error.output.statusCode)) {
        this.addError(error)
      }
    })

    this.addBind('apm:hapi:extension:start', ({ req }) => {
      return this._requestSpans.get(req)
    })
  }
}

module.exports = HapiPlugin
