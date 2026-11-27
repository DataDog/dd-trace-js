'use strict'

const { routerMiddleware, middlewareRoute } = require('../../datadog-instrumentations/src/helpers/koa-router-metadata')
const RouterPlugin = require('../../datadog-plugin-router/src')
const { normalizeRouteSegment } = require('../../dd-trace/src/http-resource')
const web = require('../../dd-trace/src/plugins/util/web')

/**
 * @typedef {{ req: object, routePath?: string }} KoaContext
 * @typedef {{ chain: Function[], cursor: number, matched?: Function, parent?: Dispatch }} Dispatch
 */

class RequestRoutes {
  #isFinalRouteStage
  /** @type {KoaContext | undefined} */
  #context
  /** @type {Function | undefined} */
  #enteredMiddleware
  /** @type {Dispatch | undefined} */
  #dispatch

  /** @param {((middleware: Function) => boolean) | undefined} isFinalRouteStage */
  constructor (isFinalRouteStage) {
    this.#isFinalRouteStage = isFinalRouteStage
  }

  /** @param {string | undefined} displayedRoute */
  readSamplingRoute (displayedRoute) {
    if (!this.#enteredMiddleware) return
    if (!this.#isFinalRouteStage?.(this.#enteredMiddleware)) return false

    const dispatch = this.#dispatch
    for (let frame = dispatch; frame; frame = frame.parent) {
      if (frame.cursor + 1 < frame.chain.length) {
        return false
      }
    }

    const routePath = this.#context?.routePath
    if (typeof routePath === 'string' && routePath) {
      return routePath
    }

    const matched = dispatch?.matched
    if (!matched) {
      return displayedRoute ? false : undefined
    }

    const route = normalizeRouteSegment(middlewareRoute(routerMiddleware.get(matched).layer))
    return route === displayedRoute ? route : false
  }

  /**
   * @param {KoaContext} context
   * @param {Function} middleware
   */
  enterMiddleware (context, middleware) {
    this.#context ??= context
    const dispatch = this.#dispatch
    const layer = routerMiddleware.get(middleware)?.layer
    if (!layer) {
      this.#enteredMiddleware = middleware
      if (dispatch) {
        dispatch.cursor = dispatch.chain.length
        dispatch.parent = undefined
      }
      return
    }
    if (!dispatch) {
      return
    }

    for (let frame = dispatch; frame; frame = frame.parent) {
      const cursor = frame.chain.indexOf(middleware, frame.cursor + 1)
      if (cursor === -1) {
        continue
      }

      frame.cursor = cursor
      if (layer.methods.length) {
        frame.matched = middleware
      }
      if (frame !== dispatch) {
        this.#dispatch = frame
      }
      return
    }
    dispatch.matched = undefined
  }

  /**
   * @param {KoaContext} context
   * @param {Function[]} chain
   */
  startDispatch (context, chain) {
    this.#context ??= context
    const dispatch = this.#dispatch
    if (dispatch && dispatch.cursor === dispatch.chain.length) {
      dispatch.chain = chain
      dispatch.cursor = -1
      dispatch.matched = undefined
    } else {
      this.#dispatch = { chain, cursor: -1, matched: undefined, parent: dispatch }
    }
  }
}

class KoaPlugin extends RouterPlugin {
  static id = 'koa'

  constructor (...args) {
    super(...args)

    this.addSub('apm:koa:request:handle', ({ req, isFinalRouteStage }) => {
      this.setFramework(req, 'koa', this.config)
      const context = web.getContext(req)
      if (context?.span) {
        web.setSamplingRouteReader(context, new RequestRoutes(isFinalRouteStage))
      }
    })

    this.addSub('apm:koa:request:route', ({ req, route }) => {
      web.setRoute(req, route)
    })

    this.addSub('apm:koa:middleware:enter', ({ req, context, middleware }) => {
      const routes = web.getContext(req)?.samplingRouteReader
      if (routes instanceof RequestRoutes) {
        routes.enterMiddleware(context, middleware)
      }
    })

    for (const name of ['koa-router', '@koa/router']) {
      this.addSub(`tracing:orchestrion:${name}:dispatch:start`, ({ context, chain }) => {
        const routes = web.getContext(context.req)?.samplingRouteReader
        if (routes instanceof RequestRoutes) {
          routes.startDispatch(context, chain)
        }
      })
    }
  }
}

module.exports = KoaPlugin
