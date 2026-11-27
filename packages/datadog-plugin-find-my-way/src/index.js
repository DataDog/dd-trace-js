'use strict'

const { storage } = require('../../datadog-core')
const { PUBLISHED_ROUTE } = require('../../dd-trace/src/http-resource')
const Plugin = require('../../dd-trace/src/plugins/plugin')
const web = require('../../dd-trace/src/plugins/util/web')

const legacyStorage = storage('legacy')
const compiledRouters = new WeakMap()
const routingSelection = Symbol('find-my-way selection')

/** @type {import('../../dd-trace/src/http-resource').RouteReader} */
const routeReader = {
  readSamplingRoute (displayedRoute, context) {
    const frame = legacyStorage.getStore()?.[routingSelection]
    const active = frame?.paths === context.paths
    if (context.samplingRoute === PUBLISHED_ROUTE) return active ? false : displayedRoute ?? ''
    if (active && frame.bareMethod) return ''
    return context.samplingRoute
  },
}

/** @param {object} req */
function bindBareMethod (req) {
  const store = legacyStorage.getStore()
  const context = web.getContext(req)
  if (context?.samplingRoute !== false || context.paths.length !== 0) return store
  const frame = store?.[routingSelection]
  if (frame?.paths === context.paths && !frame.bareMethod) return store

  return { ...store, [routingSelection]: { paths: context.paths, bareMethod: true } }
}

class FindMyWayPlugin extends Plugin {
  static id = 'find-my-way'

  constructor (...args) {
    super(...args)

    this.addSub('tracing:orchestrion:fastify:preRouting:start', req => {
      web.setSamplingRoute(req, false, routeReader)
    })

    this.addSub('tracing:orchestrion:find-my-way:lookup:start', req => {
      web.beginRouteLookup(req, routeReader)
    })

    this.addBind('tracing:orchestrion:find-my-way:selection:start', ctx => {
      const store = legacyStorage.getStore()
      const context = web.getContext(ctx.req)
      const route = context?.samplingRoute
      if (route !== false && route !== PUBLISHED_ROUTE) return store

      const previous = store?.[routingSelection]
      let owner
      if (ctx.router !== undefined) {
        owner = compiledRouters.get(ctx.router)
        if (owner === undefined) {
          owner = Symbol('compiled router')
          compiledRouters.set(ctx.router, owner)
        }
      }

      ctx.frame = { owner, paths: context.paths, previous }
      return { ...store, [routingSelection]: ctx.frame }
    })

    this.addBind('tracing:orchestrion:find-my-way:selection:asyncStart', ctx => {
      const store = legacyStorage.getStore()
      if (!ctx.frame || store?.[routingSelection] !== ctx.frame) return store

      // A callback lookup can dispatch through the same router as the enclosing lookup.
      const { previous } = ctx.frame
      const selection = previous?.owner === undefined ? previous : { ...previous, owner: undefined }
      return { ...store, [routingSelection]: selection }
    })

    this.addSub('tracing:orchestrion:find-my-way:dispatch:start', ({ req, router }) => {
      const store = legacyStorage.getStore()
      const frame = store?.[routingSelection]
      if (frame?.owner !== undefined && frame.owner === compiledRouters.get(router) &&
          web.getContext(req)?.paths === frame.paths) {
        legacyStorage.enterWith({ ...store, [routingSelection]: frame.previous })
      }
    })

    this.addBind('tracing:orchestrion:find-my-way:defaultRoute:start', ctx => bindBareMethod(ctx.arguments[0]))
    this.addBind('tracing:orchestrion:fastify:asyncConstraintError:start', ctx => bindBareMethod(ctx.req))

    this.addSub('apm:find-my-way:request:route', ({ req, route }) => {
      web.setRoute(req, route, true, routeReader)
    })
  }
}

module.exports = FindMyWayPlugin
