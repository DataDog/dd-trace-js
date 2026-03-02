'use strict'

const web = require('../../dd-trace/src/plugins/util/web')
const WebPlugin = require('../../datadog-plugin-web/src')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const { storage } = require('../../datadog-core')
const { COMPONENT } = require('../../dd-trace/src/constants')

class RouterPlugin extends WebPlugin {
  static id = 'router'

  #storeStacks = new WeakMap()
  #contexts = new WeakMap()

  constructor (...args) {
    super(...args)

    this.addSub(`apm:${this.constructor.id}:middleware:enter`, ({ req, name, route }) => {
      const childOf = this.#getActive(req) || this.#getStoreSpan()

      if (!childOf) return

      const span = this.#getMiddlewareSpan(name, childOf)
      const context = this.#createContext(req, route, childOf)

      if (childOf !== span) {
        context.middleware.push(span)
      }

      const store = storage('legacy').getStore()
      let storeStack = this.#storeStacks.get(req)
      if (!storeStack) {
        storeStack = []
        this.#storeStacks.set(req, storeStack)
      }
      storeStack.push(store)
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
      const storeStack = this.#storeStacks.get(req)
      const savedStore = storeStack && storeStack.pop()
      if (storeStack && storeStack.length === 0) {
        this.#storeStacks.delete(req)
      }
      const span = savedStore && savedStore.span
      this.enter(span, savedStore)
    })

    this.addSub(`apm:${this.constructor.id}:middleware:error`, ({ req, error }) => {
      web.addError(req, error)

      if (!this.config.middleware) return

      const span = this.#getActive(req)

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

  #getActive (req) {
    const context = this.#contexts.get(req)

    if (!context) return
    if (context.middleware.length === 0) return context.span

    return context.middleware.at(-1)
  }

  #getStoreSpan () {
    const store = storage('legacy').getStore()

    return store && store.span
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

  #createContext (req, route, span) {
    let context = this.#contexts.get(req)

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
    } else {
      context = {
        span,
        stack: [route],
        route,
        middleware: [],
      }

      this.#contexts.set(req, context)
    }

    return context
  }
}

function isMoreSpecificThan (routeA, routeB) {
  if (!routeIsRegex(routeA) && routeIsRegex(routeB)) {
    return true
  }
  return routeA.length > routeB.length
}

function routeIsRegex (route) {
  return route.includes('(/')
}

module.exports = RouterPlugin
