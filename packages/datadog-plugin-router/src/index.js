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
      const store = storage.getStore()
      const context = this._createContext(req, route)
      const span = this._getMiddlewareSpan(context, store, name)

      this.enter(span, store)

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

    this.addSub(`apm:${this.constructor.name}:middleware:error`, this.addError)

    this.addSub(`apm:http:server:request:finish`, ({ req }) => {
      const context = this._contexts.get(req)

      if (!context) return

      let span

      while ((span = context.middleware.pop())) {
        span.finish()
      }
    })
  }

  _getMiddlewareSpan (context, store, name) {
    const childOf = store && store.span

    if (this.config.middleware === false) {
      return childOf
    }

    const span = this.tracer.startSpan(`${this.constructor.name}.middleware`, {
      childOf,
      tags: {
        'resource.name': name || '<anonymous>'
      }
    })

    context.middleware.push(span)

    analyticsSampler.sample(span, this.config.measured)

    return span
  }

  _createContext (req, route) {
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
