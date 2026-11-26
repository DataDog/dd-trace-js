'use strict'

const web = require('../../dd-trace/src/plugins/util/web')
const WebPlugin = require('../../datadog-plugin-web/src')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const { storage } = require('../../datadog-core')
const { COMPONENT } = require('../../dd-trace/src/constants')
const { joinRoute, normalizeRouteSegment } = require('../../dd-trace/src/http-resource')

/**
 * @typedef {{ req: import('node:http').IncomingMessage, layer: { path?: string },
 *   pattern?: string | RegExp, active: boolean }} RouteSelection
 */

class RouterPlugin extends WebPlugin {
  static id = 'router'

  #contexts = new WeakMap()

  constructor (...args) {
    super(...args)

    const id = this.constructor.id
    if (id === 'express' || id === 'router') {
      const { getLayerMeta, resolveLayerRoute } = require('../../datadog-instrumentations/src/helpers/router-helper')
      this.addSub(`tracing:orchestrion:${id}:routeParams:start`, /** @param {RouteSelection} selection */ selection => {
        const { req, layer, pattern } = selection
        const meta = getLayerMeta(layer)
        if (!meta || (meta.needMultiMatch && pattern === undefined)) return

        const context = this.#contexts.get(req)
        const prefix = context && joinRoute(context.stack)
        const path = normalizeRouteSegment(resolveLayerRoute(meta, layer, pattern))
        const template = prefix ? prefix + path : path
        if (context && context.route !== template && !isMoreSpecificThan(template, context.route)) return

        web.scopeSamplingRoute(req, template, selection)
      })
    }

    this.addSub(`apm:${this.constructor.id}:middleware:enter`, ({ req, name, route, layer }) => {
      // One ALS hop covers both the parent-span fallback (when no
      // per-request context exists yet) and the `storeStack` push below.
      // The previous shape paid an ALS read inside `#getStoreSpan` and a
      // second one here for the saved-store push.
      const store = storage('legacy').getStore()
      let context = this.#contexts.get(req)
      let childOf
      if (context !== undefined) {
        const middleware = context.middleware
        childOf = middleware.length === 0 ? context.span : middleware.at(-1)
      } else if (store) {
        childOf = store.span
      }
      if (!childOf) return

      const span = this.#getMiddlewareSpan(name, childOf)
      const matched = Boolean(layer?.route)
      context = this.#updateContext(req, context, route, childOf, matched)

      if (childOf !== span) {
        context.middleware.push(span)
      }

      context.storeStack.push(store)
      this.enter(span, store)

      web.patch(req)
      const samplingRoute = matched && context.matchedPath === context.route ? context.route : false
      web.setRoute(req, context.route, samplingRoute)
    })

    this.addSub(`apm:${this.constructor.id}:middleware:next`, ({ req }) => {
      const context = this.#contexts.get(req)

      if (!context) return

      context.stack.pop()
      if (context.stack.length < context.matchDepth) {
        context.matchDepth = 0
        web.setSamplingRoute(req)
      }
    })

    this.addSub(`apm:${this.constructor.id}:middleware:finish`, ({ req }) => {
      const context = this.#contexts.get(req)

      if (!context || context.middleware.length === 0) return

      context.middleware.pop().finish()
    })

    this.addSub(`apm:${this.constructor.id}:middleware:exit`, ({ req }) => {
      const context = this.#contexts.get(req)
      const savedStore = context && context.storeStack.pop()
      const span = savedStore && savedStore.span
      this.enter(span, savedStore)
    })

    this.addSub(`apm:${this.constructor.id}:middleware:error`, ({ req, error }) => {
      web.addError(req, error)

      if (!this.config.middleware) return

      const context = this.#contexts.get(req)
      if (!context) return
      const middleware = context.middleware
      const span = middleware.length === 0 ? context.span : middleware.at(-1)
      if (!span) return

      span.setTag('error', error)
    })

    this.addSub(`apm:${this.constructor.id}:middleware:repeat`, ({ req, name, error }) => {
      // The middleware span already finished on the first `next`, so record the
      // repeat on the still-live request span instead of a finished one.
      web.root(req)?.addEvent('middleware.next_called_again', {
        'middleware.name': name || '<anonymous>',
        with_error: Boolean(error && error !== 'route' && error !== 'router'),
      })
    })

    this.addSub('apm:http:server:request:finish', ({ req }) => {
      const context = this.#contexts.get(req)

      if (!context) return

      let span

      while ((span = context.middleware.pop())) {
        span.finish()
      }
    })
  }

  #getMiddlewareSpan (name, childOf) {
    if (this.config.middleware === false) {
      return childOf
    }

    const span = this.tracer.startSpan(`${this.constructor.id}.middleware`, {
      childOf,
      integrationName: this.constructor.id,
      tags: {
        [COMPONENT]: this.constructor.id,
        'resource.name': name || '<anonymous>',
      },
    })

    analyticsSampler.sample(span, this.config.measured)

    return span
  }

  #updateContext (req, context, route, span, matched) {
    route = normalizeRouteSegment(route)

    if (context) {
      context.stack.push(route)

      route = context.stack.join('')

      if (matched) {
        context.matchedPath = route
        context.matchDepth = context.stack.length
      }

      // Longer route is more likely to be the actual route handler route.
      if (isMoreSpecificThan(route, context.route)) {
        context.route = route
      }
      return context
    }

    context = {
      span,
      stack: [route],
      route,
      matchedPath: matched ? route : undefined,
      matchDepth: matched ? 1 : 0,
      middleware: [],
      storeStack: [],
    }

    this.#contexts.set(req, context)
    return context
  }
}

function isMoreSpecificThan (routeA, routeB) {
  // Concrete paths beat catch-all wildcards (`/*splat`, `/api/*`) on the same
  // request so that `/foo/bar` wins over `/foo/*splat` regardless of length.
  if (routeA && routeB) {
    const aWild = hasWildcard(routeA)
    const bWild = hasWildcard(routeB)
    if (aWild !== bWild) return !aWild
  }
  if (!routeIsRegex(routeA) && routeIsRegex(routeB)) {
    return true
  }
  return routeA.length > routeB.length
}

function routeIsRegex (route) {
  return route.includes('(/')
}

function hasWildcard (route) {
  // RegExp routes are encoded as `(/.../)` and may legitimately contain `*`,
  // so only treat plain string patterns as wildcards.
  return !routeIsRegex(route) && route.includes('*')
}

module.exports = RouterPlugin
