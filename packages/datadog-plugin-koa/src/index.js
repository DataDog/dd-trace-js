'use strict'

const { routerMiddleware, middlewareRoute } = require('../../datadog-instrumentations/src/helpers/koa-router-metadata')
const RouterPlugin = require('../../datadog-plugin-router/src')
const { normalizeRouteSegment } = require('../../dd-trace/src/http-resource')
const web = require('../../dd-trace/src/plugins/util/web')

/**
 * @typedef {{ req: object, routePath?: string }} KoaContext
 * @typedef {{ context: KoaContext, chain?: Function[], matched?: Function }} Dispatch
 */

class KoaPlugin extends RouterPlugin {
  static id = 'koa'

  /** @type {WeakMap<KoaContext, Dispatch>} */
  #dispatches = new WeakMap()

  constructor (...args) {
    super(...args)

    this.addSub('apm:koa:request:handle', ({ req }) => {
      this.setFramework(req, 'koa', this.config)
    })

    this.addSub('apm:koa:request:route', ({ req, route }) => {
      web.setRoute(req, route)
    })

    this.addSub('apm:koa:middleware:enter', ({ context, middleware }) => {
      const dispatch = this.#getDispatch(context)
      if (dispatch?.chain && routerMiddleware.get(middleware)?.layer.methods.length) {
        dispatch.matched = middleware
      }
    })

    for (const name of ['koa-router', '@koa/router']) {
      this.addSub(`tracing:orchestrion:${name}:dispatch:start`, ({ context, chain }) => {
        const dispatch = this.#getDispatch(context)
        if (dispatch) {
          dispatch.chain = chain
          dispatch.matched = undefined
        }
      })
    }
  }

  /**
   * @param {KoaContext} context
   */
  #getDispatch (context) {
    let dispatch = this.#dispatches.get(context)
    if (!dispatch && web.root(context.req)) {
      dispatch = { context, chain: undefined, matched: undefined }
      this.#dispatches.set(context, dispatch)
      web.setSamplingRoute(context.req, (_req, route) => samplingRoute(dispatch, route))
    }
    return dispatch
  }
}

/**
 * @param {Dispatch} dispatch
 * @param {string | undefined} displayedRoute
 */
function samplingRoute (dispatch, displayedRoute) {
  const { context, chain, matched } = dispatch
  if (typeof context.routePath === 'string' && context.routePath) return context.routePath
  if (!chain || !matched) return

  const index = chain.indexOf(matched)
  if (index === -1) return
  const route = normalizeRouteSegment(middlewareRoute(routerMiddleware.get(matched).layer))
  if (route !== displayedRoute) return

  for (let next = index + 1; next < chain.length; next++) {
    const layer = routerMiddleware.get(chain[next])?.layer
    if (layer && normalizeRouteSegment(middlewareRoute(layer)) !== route) return
  }

  return route
}

module.exports = KoaPlugin
