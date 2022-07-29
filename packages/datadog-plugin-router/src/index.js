'use strict'

const web = require('../../dd-trace/src/plugins/util/web')
const WebPlugin = require('../../datadog-plugin-web/src')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const { storage } = require('../../datadog-core')

class RouterPlugin extends WebPlugin {
  static get name () {
    return 'router'
  }

  constructor (...args) {
    super(...args)

    this._contexts = new WeakMap()

    this.addSub(`apm:${this.constructor.name}:middleware:enter`, ({ req, name, route }) => {
      const childOf = this._getActive(req) || this._getStoreSpan()

      if (!childOf) return

      const span = this._getMiddlewareSpan(name, childOf)
      const context = this._createContext(req, route, childOf)

      if (childOf !== span) {
        context.middleware.push(span)
      }

      this.enter(span)

      web.patch(req)
      web.setRoute(req, context.route)
    })

    this.addSub(`apm:${this.constructor.name}:middleware:next`, ({ req }) => {
      const context = this._contexts.get(req)

      if (!context) return

      context.stack.pop()
    })

    this.addSub(`apm:${this.constructor.name}:middleware:exit`, ({ req }) => {
      const context = this._contexts.get(req)

      if (!context || context.middleware.length === 0) return

      context.middleware.pop().finish()
    })

    this.addSub(`apm:${this.constructor.name}:middleware:error`, ({ req, error }) => {
      web.addError(req, error)

      if (!this.config.middleware) return

      const span = this._getActive(req)

      if (!span) return

      span.setTag('error', error)
    })

    this.addSub(`apm:http:server:request:finish`, ({ req }) => {
      const context = this._contexts.get(req)

      if (!context) return

      let span

      while ((span = context.middleware.pop())) {
        span.finish()
      }
    })
  }

  _getActive (req) {
    const context = this._contexts.get(req)

    if (!context) return
    if (context.middleware.length === 0) return context.span

    return context.middleware[context.middleware.length - 1]
  }

  _getStoreSpan () {
    const store = storage.getStore()

    return store && store.span
  }

  _getMiddlewareSpan (name, childOf) {
    if (this.config.middleware === false) {
      return childOf
    }

    const span = this.tracer.startSpan(`${this.constructor.name}.middleware`, {
      childOf,
      tags: {
        'resource.name': name || '<anonymous>'
      }
    })

    analyticsSampler.sample(span, this.config.measured)

    return span
  }

  _createContext (req, route, span) {
    let context = this._contexts.get(req)

    if (!route || route === '/' || route === '*') {
      route = ''
    }

    if (context) {
      context.stack.push(route)

      route = context.stack.join('')

      // Longer route is more likely to be the actual route handler route.
      if (route.length > context.route.length) {
        context.route = route
      }
    } else {
      context = {
        span,
        stack: [route],
        route,
        middleware: []
      }

      this._contexts.set(req, context)
    }

    return context
  }
}

module.exports = RouterPlugin
