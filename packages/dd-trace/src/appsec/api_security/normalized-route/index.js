'use strict'

const { HTTP_ROUTE } = require('../../../../../../ext/tags')
const { getParse, getMatch } = require('../../../../../datadog-instrumentations/src/path-to-regexp')
const web = require('../../../plugins/util/web')
const { normalizeRoute: normalizeRouteExpress } = require('./express')
const { normalizeRoute: normalizeRouteFastify } = require('./fastify')
const { getMatchedRoute } = require('./matched-routes')

/**
 * Normalize the route using the framework that owns the HTTP span.
 * @param {{ app?: { del?: Function }, params?: object, originalUrl?: string, url?: string }} req
 */
function normalizeRoute (req) {
  const spanContext = web.root(req)?.context()
  const component = spanContext?.getTag?.('component')
  const route = spanContext?.getTag?.(HTTP_ROUTE)

  switch (component) {
    case 'express':
      // Express 5 removed app.del; the serving app distinguishes mixed-major processes.
      if (typeof req.app?.del === 'function') return null
      return normalizeRouteExpress(route, req.params, req.originalUrl || req.url, getParse(), getMatch())
    case 'fastify': {
      const context = web.getContext(req)
      // A manually overridden http.route must not be paired with a different matched branch.
      if (context?.paths?.length !== 1 || context.paths[0] !== route) return null
      return normalizeRouteFastify(getMatchedRoute(context.paths))
    }
    default:
      return null
  }
}

module.exports = { normalizeRoute }
