'use strict'

const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const { COMPONENT } = require('../../dd-trace/src/constants')
const web = require('../../dd-trace/src/plugins/util/web')
const WebPlugin = require('../../datadog-plugin-web/src')
const { RESOURCE_NAME, HTTP_ROUTE } = require('../../../ext/tags')

/**
 * React Router Framework Mode plugin.
 *
 * Enrich the active Express/http request span with parameterized route patterns
 * from React Router's ServerInstrumentation API, and create child spans for
 * loaders and actions.
 *
 * @see https://github.com/DataDog/dd-trace-js/issues/5486
 */
class ReactRouterPlugin extends WebPlugin {
  static id = 'react-router'

  /** @type {{ span: import('../../dd-trace/src/opentracing/span'), parentStore: object }[]} */
  #handlerStack = []

  constructor (...args) {
    super(...args)

    this.addSub('apm:react-router:request:route', ({ route, method }) => {
      this.#setRoute(route, method)
    })

    this.addSub('apm:react-router:request:error', ({ error }) => {
      this.#tagError(error)
    })

    this.addSub('apm:react-router:loader:start', message => {
      this.#startHandlerSpan('loader', message)
    })
    this.addSub('apm:react-router:loader:finish', () => {
      this.#finishHandlerSpan()
    })
    this.addSub('apm:react-router:loader:error', ({ error }) => {
      this.#tagHandlerError(error)
    })

    this.addSub('apm:react-router:action:start', message => {
      this.#startHandlerSpan('action', message)
    })
    this.addSub('apm:react-router:action:finish', () => {
      this.#finishHandlerSpan()
    })
    this.addSub('apm:react-router:action:error', ({ error }) => {
      this.#tagHandlerError(error)
    })
  }

  /**
   * @param {string} route
   * @param {string | undefined} method
   */
  #setRoute (route, method) {
    if (!route) return

    const store = storage('legacy').getStore()
    const req = store?.req

    if (req) {
      web.patch(req)
      web.setRoute(req, route)
    }

    const span = (req && web.root(req)) || store?.span
    if (!span) return

    span.setTag(HTTP_ROUTE, route)
    if (method) {
      span.setTag(RESOURCE_NAME, `${method} ${route}`)
    }
  }

  /**
   * @param {'loader' | 'action'} kind
   * @param {{ routeId?: string, pattern?: string }} message
   */
  #startHandlerSpan (kind, message) {
    const store = storage('legacy').getStore()
    const childOf = store?.span
    if (!childOf) return

    const pattern = message.pattern || message.routeId || kind
    const span = this.tracer.startSpan(`react-router.${kind}`, {
      childOf,
      integrationName: this.constructor.id,
      tags: {
        [COMPONENT]: this.constructor.id,
        [RESOURCE_NAME]: pattern,
        'react-router.route_id': message.routeId,
      },
    })

    analyticsSampler.sample(span, this.config.measured, true)

    this.#handlerStack.push({ span, parentStore: store })
    this.enter(span, store)
  }

  #finishHandlerSpan () {
    const active = this.#handlerStack.pop()
    if (!active) return

    active.span.finish()
    storage('legacy').enterWith(active.parentStore)
  }

  /**
   * @param {unknown} error
   */
  #tagHandlerError (error) {
    const active = this.#handlerStack.at(-1)
    if (active) {
      this.addError(error, active.span)
    }
    this.#tagError(error)
  }

  /**
   * @param {unknown} error
   */
  #tagError (error) {
    const store = storage('legacy').getStore()
    const req = store?.req
    if (req) {
      web.addError(req, error)
      return
    }
    if (store?.span) {
      this.addError(error, store.span)
    }
  }
}

module.exports = ReactRouterPlugin
