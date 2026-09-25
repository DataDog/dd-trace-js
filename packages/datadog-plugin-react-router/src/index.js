'use strict'

const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const { COMPONENT } = require('../../dd-trace/src/constants')
const log = require('../../dd-trace/src/log')
const WebPlugin = require('../../datadog-plugin-web/src')
const { HTTP_ROUTE, HTTP_URL, RESOURCE_NAME } = require('../../../ext/tags')

/**
 * @typedef {{ arguments: unknown[], result: Array<{ route?: { path?: string } }> | null }} RouteMatchContext
 * @typedef {object} HandlerContext
 * @property {string} routeId
 * @property {string} [pattern]
 * @property {(result: unknown, rejected: boolean) => void} [complete]
 */

class ReactRouterPlugin extends WebPlugin {
  static id = 'react-router'

  /**
   * @param {object} tracer
   * @param {import('../../dd-trace/src/config/config-base')} tracerConfig
   */
  constructor (tracer, tracerConfig) {
    super(tracer, tracerConfig)

    this.addSub('tracing:orchestrion:react-router:matchServerRoutes:end', ctx => {
      this.#setRouteFromMatches(/** @type {RouteMatchContext} */ (ctx))
    })
    this.addBind('apm:react-router:loader:start', ctx => {
      return this.#startHandlerSpan('loader', /** @type {HandlerContext} */ (ctx))
    })
    this.addBind('apm:react-router:action:start', ctx => {
      return this.#startHandlerSpan('action', /** @type {HandlerContext} */ (ctx))
    })
  }

  /** @param {RouteMatchContext} ctx */
  #setRouteFromMatches (ctx) {
    const matches = ctx.result
    if (!matches?.length) return

    const span = /** @type {import('../../dd-trace/src/opentracing/span') | undefined} */ (
      storage('legacy').getStore()?.span
    )
    if (!span) return
    const httpUrl = span.context().getTag(HTTP_URL)
    if (typeof httpUrl !== 'string') return

    let pathname
    try {
      pathname = new URL(httpUrl, 'http://localhost').pathname
    } catch (error) {
      log.debug('Skipping React Router route for invalid HTTP URL: %s', error)
      return
    }
    if (pathname.endsWith('/_root.data')) {
      pathname = pathname.slice(0, -'/_root.data'.length) || '/'
    } else if (pathname.endsWith('.data')) {
      pathname = pathname.slice(0, -'.data'.length)
    }
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1)

    const args = ctx.arguments
    const matchedPathname = typeof args[1] === 'string' ? args[1] : args[3] ?? args[2]
    if (pathname !== matchedPathname && pathname + '/' !== matchedPathname &&
      !(pathname.endsWith('/_') && pathname.slice(0, -1) === matchedPathname)) return

    let route = ''
    for (const match of matches) {
      const path = match.route?.path
      if (path) route += '/' + path
    }
    route = route.replaceAll(/\/+/g, '/') || '/'

    span.setTag(HTTP_ROUTE, route)
  }

  /**
   * @param {'loader' | 'action'} kind
   * @param {HandlerContext} ctx
   */
  #startHandlerSpan (kind, ctx) {
    const store = storage('legacy').getStore()
    const childOf = store?.span
    if (!childOf) return store

    const span = this.tracer.startSpan('react-router.' + kind, {
      childOf,
      integrationName: ReactRouterPlugin.id,
      tags: {
        [COMPONENT]: ReactRouterPlugin.id,
        [RESOURCE_NAME]: ctx.pattern || ctx.routeId || kind,
        'react-router.route_id': ctx.routeId,
      },
    })
    analyticsSampler.sample(span, this.config.measured, true)

    ctx.complete = (result, rejected) => {
      const outcome = /** @type {{ status?: string, error?: Error }} */ (result)
      const error = rejected ? result : outcome?.status === 'error' ? outcome.error : undefined
      try {
        if (error !== undefined && !span.context().getTag('error')) {
          span.setTag('error', error || 1)
        }
      } catch (failure) {
        log.error('Error in react-router completion: %s', failure)
        this.configure(false)
      } finally {
        try {
          span.finish()
        } catch (failure) {
          log.error('Error finishing react-router span: %s', failure)
          this.configure(false)
        }
      }
    }
    return { ...store, span }
  }
}

module.exports = ReactRouterPlugin
