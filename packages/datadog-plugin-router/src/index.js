'use strict'

const { PUBLISHED_ROUTE, joinRoute, normalizeRouteSegment } = require('../../dd-trace/src/http-resource')
const web = require('../../dd-trace/src/plugins/util/web')
const WebPlugin = require('../../datadog-plugin-web/src')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const { storage } = require('../../datadog-core')
const { COMPONENT } = require('../../dd-trace/src/constants')

class RouterPlugin extends WebPlugin {
  static id = 'router'

  #contexts = new WeakMap()
  #delegatedRoutes

  constructor (...args) {
    super(...args)

    const id = this.constructor.id
    const tracksSelection = id === 'router' || id === 'express'
    this.addSub(`apm:${id}:middleware:enter`, ({ req, name, route, layer }) => {
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
      const previousRoute = context?.route
      context = this.#updateContext(req, context, route, childOf)

      if (childOf !== span) {
        context.middleware.push(span)
      }

      context.storeStack.push(store)
      this.enter(span, store)

      const request = web.patch(req)
      if (tracksSelection) {
        if (request.samplingRoute === false && context.route === '') return
        if (request.samplingRoute === PUBLISHED_ROUTE) {
          if (!layer?.route) {
            if (context.stack.at(-1) === '') return
            const paths = request.paths
            const reader = request.samplingRouteReader
            web.setRoute(req, joinRoute(context.stack))
            this.#delegatedRoutes ??= new WeakMap()
            this.#delegatedRoutes.set(context, {
              paths,
              reader,
              previousRoute,
              middlewarePaths: request.paths,
              depth: context.stack.length,
            })
            return
          }
          if (context.route === '') {
            if (route === '/' || layer.route.path === '/') {
              web.replacePublishedRouteWithRoot(req)
              return
            }
            web.setSamplingRoute(req)
          }
        }
      }
      const delegated = tracksSelection && !layer?.route && this.#delegatedRoutes?.get(context)
      const tracksMiddleware = delegated && request.paths === delegated.middlewarePaths
      web.setRoute(req, context.route)
      if (tracksMiddleware) delegated.middlewarePaths = request.paths
    })

    this.addSub(`apm:${this.constructor.id}:middleware:next`, ({ req }) => {
      const context = this.#contexts.get(req)

      if (!context) return

      context.stack.pop()
      const delegated = this.#delegatedRoutes?.get(context)
      if (delegated && context.stack.length < delegated.depth) {
        this.#delegatedRoutes.delete(context)
        const request = web.getContext(req)
        if (request?.paths === delegated.middlewarePaths) {
          web.setRoute(req, joinRoute(delegated.paths), true, delegated.reader)
          request.paths = delegated.paths
          context.route = delegated.previousRoute ?? ''
        }
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

  #updateContext (req, context, route, span) {
    route = normalizeRouteSegment(route)

    if (context) {
      context.stack.push(route)

      route = context.stack.join('')

      // Longer route is more likely to be the actual route handler route.
      if (isMoreSpecificThan(route, context.route)) {
        context.route = route
      }
      return context
    }

    // Five-property shape pinned at allocation so every request shares the
    // same hidden class — no per-field transitions after construction.
    context = {
      span,
      stack: [route],
      route,
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
