'use strict'

const { HTTP_ROUTE } = require('../../../ext/tags')
const {
  getLayerMeta,
  recordNativeRouterMatch,
  resolveNativeRouterRoute,
} = require('../../datadog-instrumentations/src/helpers/router-helper')
const { PUBLISHED_ROUTE, joinRoute, normalizeRouteSegment } = require('../../dd-trace/src/http-resource')
const web = require('../../dd-trace/src/plugins/util/web')
const WebPlugin = require('../../datadog-plugin-web/src')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const { storage } = require('../../datadog-core')
const { COMPONENT } = require('../../dd-trace/src/constants')

/**
 * @typedef {{
 *   selection: { active: boolean }, route: string, pathDepth: number, previous?: ProvisionalRoute,
 * }} ProvisionalRoute
 */

class ProvisionalRouteReader {
  /** @type {ProvisionalRoute | undefined} */
  #selected
  #previous

  /** @param {import('../../dd-trace/src/http-resource').RouteReader | undefined} previous */
  constructor (previous) {
    this.#previous = previous
  }

  /**
   * @param {{ active: boolean }} selection
   * @param {string} route
   * @param {string[]} paths
   */
  select (selection, route, paths) {
    this.#selected = { selection, route, pathDepth: paths.length, previous: this.#findActive(paths) }
  }

  hasPublishedReader () {
    return web.isPublishedRouteReader(this.#previous)
  }

  /** @param {string[]} paths */
  getProvisionalRoute (paths) {
    return this.#findActive(paths)?.route
  }

  /**
   * @param {string | undefined} displayedRoute
   * @param {import('../../dd-trace/src/http-resource').HttpResourceSource} source
   */
  readSamplingRoute (displayedRoute, source) {
    const route = this.getProvisionalRoute(source.paths)
    if (route === undefined) return this.#previous?.readSamplingRoute(displayedRoute, source)
    return web.isSelectingRoute(source.paths) ? false : route
  }

  /** @param {string[]} paths */
  #findActive (paths) {
    let result = this.#selected
    while (result && (!result.selection.active || result.pathDepth !== paths.length)) {
      result = result.previous
    }
    return result
  }
}

class RouterPlugin extends WebPlugin {
  static id = 'router'

  #contexts = new WeakMap()
  #delegatedRoutes

  constructor (...args) {
    super(...args)

    const id = this.constructor.id
    const tracksSelection = id === 'router' || id === 'express'
    if (id === 'router') {
      this.addSub('tracing:orchestrion:router:routeMatch:start', recordNativeRouterMatch)
      this.addSub('tracing:orchestrion:router:routeParams:end', recordNativeRouterMatch)
    }
    if (tracksSelection) {
      this.addSub(`tracing:orchestrion:${id}:routeParams:start`, selection => {
        const { req, layer, pattern } = selection
        const request = web.getContext(req)
        const metadata = getLayerMeta(layer)
        if (!request?.span || !metadata) return

        if (metadata.nativeSingleGroup && pattern === undefined) {
          // Nested routers can dispatch while these parameter callbacks run.
          selection.path = layer.path
        }
        const route = metadata.needMultiMatch
          ? resolveNativeRouterRoute(metadata, pattern, layer)
          : metadata.captureRoute
        if (typeof route !== 'string') return

        const context = this.#contexts.get(req)
        const prefix = context && joinRoute(context.stack)
        const template = prefix ? prefix + route : route
        if (context && context.route !== template && !isMoreSpecificThan(template, context.route)) return

        let reader = request.samplingRouteReader
        if (!(reader instanceof ProvisionalRouteReader)) {
          reader = new ProvisionalRouteReader(reader)
          web.setSamplingRouteReader(request, reader)
        }
        reader.select(selection, template, request.paths)
      })
    }

    this.addSub(`apm:${id}:middleware:enter`, ({ req, name, route, layer, routeSelected }) => {
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
      const matched = tracksSelection && layer?.route && typeof route === 'string' &&
        (routeSelected || this.config.DD_TRACE_OTEL_SEMANTICS_ENABLED)
      const previousRoute = context?.route
      context = this.#updateContext(req, context, route, childOf)

      if (childOf !== span) {
        context.middleware.push(span)
      }

      context.storeStack.push(store)
      this.enter(span, store)

      const request = web.patch(req)
      if (!tracksSelection) {
        web.setRoute(req, context.route)
        return
      }

      const selected = Boolean(
        matched && (context.route !== previousRoute || joinRoute(context.stack) === context.route)
      )
      const reader = request.samplingRouteReader
      const provisional = reader instanceof ProvisionalRouteReader ? reader : undefined
      const activeProvisional = provisional?.getProvisionalRoute(request.paths) !== undefined
      if (!selected && activeProvisional) {
        context.route = previousRoute ?? ''
        return
      }
      if (request.samplingRoute === false && context.route === '' && !matched) return
      if (request.samplingRoute === PUBLISHED_ROUTE && !layer?.route) {
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
      if (route === undefined) return

      // A delegated handler can fall through while its caller still owns the route.
      const retained = selected && request.span && (activeProvisional || context.selectedPrevious ||
        (request.samplingRoute === PUBLISHED_ROUTE &&
          (web.isPublishedRouteReader(reader) || provisional?.hasPublishedReader())))
      const previous = retained
        ? {
            reader,
            paths: request.paths,
            samplingRoute: request.samplingRoute,
            generatedRoute: request.generatedRoute,
            tag: request.span.context().getTag(HTTP_ROUTE),
            route: previousRoute ?? '',
            selectedPaths: context.selectedPaths,
            selectedDepth: context.selectedDepth,
            parent: context.selectedPrevious,
          }
        : undefined
      const root = context.route === '' && route === '/' && layer?.route
      const delegated = !layer?.route && this.#delegatedRoutes?.get(context)
      const tracksMiddleware = delegated && request.paths === delegated.middlewarePaths
      const paths = (root ? web.replacePublishedRouteWithRoot(req) : undefined) ??
        web.setRoute(req, context.route, selected)
      if (tracksMiddleware) delegated.middlewarePaths = request.paths
      if (selected && paths) {
        context.selectedPaths = paths
        context.selectedDepth = context.stack.length
        context.selectedPrevious = previous
      }
    })

    this.addSub(`apm:${this.constructor.id}:middleware:next`, ({ req }) => {
      const context = this.#contexts.get(req)

      if (!context) return

      context.stack.pop()
      if (context.selectedPaths && context.stack.length < context.selectedDepth) {
        const request = web.getContext(req)
        const previous = context.selectedPrevious
        if (request?.paths === context.selectedPaths) {
          if (previous) {
            request.paths = previous.paths
            request.samplingRoute = previous.samplingRoute
            request.samplingRouteReader = previous.reader
            if (request.generatedRoute !== undefined &&
              request.span.context().getTag(HTTP_ROUTE) === request.generatedRoute) {
              request.span.setTag(HTTP_ROUTE, previous.tag)
            }
            request.generatedRoute = previous.generatedRoute
            context.route = previous.route
          } else {
            web.setSamplingRoute(req)
          }
        }
        context.selectedPaths = previous?.selectedPaths
        context.selectedDepth = previous?.selectedDepth ?? 0
        context.selectedPrevious = previous?.parent
      }
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

    context = {
      span,
      stack: [route],
      route,
      middleware: [],
      storeStack: [],
      selectedPaths: undefined,
      selectedDepth: 0,
      selectedPrevious: undefined,
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
