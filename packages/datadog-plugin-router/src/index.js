'use strict'

const web = require('../../dd-trace/src/plugins/util/web')
const WebPlugin = require('../../datadog-plugin-web/src')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const { storage } = require('../../datadog-core')
const { COMPONENT } = require('../../dd-trace/src/constants')

class RouterPlugin extends WebPlugin {
  static id = 'router'

  #contexts = new WeakMap()

  constructor (...args) {
    super(...args)

    this.addSub(`apm:${this.constructor.id}:middleware:enter`, ({ req, name, route }) => {
      // One ALS hop covers both the parent-span fallback (when no
      // per-request context exists yet) and the `storeStack` push below.
      // The previous shape paid an ALS read inside `#getStoreSpan` and a
      // second one here for the saved-store push.
      const store = storage('legacy').getStore()
      let context = this.#contexts.get(req)
      let childOf
      if (context !== undefined) {
        const middleware = context.middleware
        childOf = middleware.length === 0 ? context.span : middleware[middleware.length - 1]
      } else if (store) {
        childOf = store.span
      }
      if (!childOf) return

      const span = this.#getMiddlewareSpan(name, childOf)
      context = this.#updateContext(req, context, route, childOf)

      if (childOf !== span) {
        context.middleware.push(span)
      }

      context.storeStack.push(store)
      this.enter(span, store)

      web.patch(req)
      web.setRoute(req, context.route)
    })

    this.addSub(`apm:${this.constructor.id}:middleware:next`, ({ req }) => {
      const context = this.#contexts.get(req)

      if (!context) return

      context.stack.pop()
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
      const span = middleware.length === 0 ? context.span : middleware[middleware.length - 1]
      if (!span) return

      span.setTag('error', error)
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
    })
    span._addTags({
      [COMPONENT]: this.constructor.id,
      'resource.name': name || '<anonymous>',
    })

    analyticsSampler.sample(span, this.config.measured)

    return span
  }

  #updateContext (req, context, route, span) {
    if (!route || route === '/' || route === '*') {
      route = ''
    }

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
