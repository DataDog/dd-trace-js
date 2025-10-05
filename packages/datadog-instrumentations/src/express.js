'use strict'

const { createWrapRouterMethod } = require('./router')
const shimmer = require('../../datadog-shimmer')
const { addHook, channel, tracingChannel } = require('./helpers/instrument')
const {
  setRouterMountPath,
  joinPath,
  getLayerMatchers,
  normalizeMethodName,
  markAppMounted,
  normalizeRoutePaths,
  wrapRouteMethodsAndPublish,
  extractMountPaths,
  hasRouterCycle,
  getRouteFullPaths
} = require('./helpers/router-helper')

const handleChannel = channel('apm:express:request:handle')
const routeAddedChannel = channel('apm:express:route:added')

function wrapHandle (handle) {
  return function handleWithTrace (req, res) {
    if (handleChannel.hasSubscribers) {
      handleChannel.publish({ req })
    }

    return handle.apply(this, arguments)
  }
}

const wrapRouterMethod = createWrapRouterMethod('express')

const responseJsonChannel = channel('datadog:express:response:json:start')

function wrapResponseJson (json) {
  return function wrappedJson (obj) {
    if (responseJsonChannel.hasSubscribers) {
      // backward compat as express 4.x supports deprecated 3.x signature
      if (arguments.length === 2 && typeof arguments[1] !== 'number') {
        obj = arguments[1]
      }

      responseJsonChannel.publish({ req: this.req, res: this, body: obj })
    }

    return json.apply(this, arguments)
  }
}

const responseRenderChannel = tracingChannel('datadog:express:response:render')

function wrapResponseRender (render) {
  return function wrappedRender (view, options, callback) {
    if (!responseRenderChannel.start.hasSubscribers) {
      return render.apply(this, arguments)
    }

    return responseRenderChannel.traceSync(
      render,
      {
        req: this.req,
        view,
        options
      },
      this,
      ...arguments
    )
  }
}

function wrapAppAll (all) {
  return function wrappedAll (path) {
    if (!routeAddedChannel.hasSubscribers) return all.apply(this, arguments)

    const paths = normalizeRoutePaths(path)

    for (const p of paths) {
      routeAddedChannel.publish({ method: '*', path: p })
    }

    return all.apply(this, arguments)
  }
}

// Wrap app.route() to instrument Route object
function wrapAppRoute (route) {
  return function wrappedRoute (path) {
    const routeObj = route.apply(this, arguments)

    if (!routeAddedChannel.hasSubscribers) return routeObj

    const paths = normalizeRoutePaths(path)

    if (!paths.length) return routeObj

    wrapRouteMethodsAndPublish(routeObj, paths, ({ method, path }) => {
      routeAddedChannel.publish({ method, path })
    })

    return routeObj
  }
}

function wrapAppUse (use) {
  return function wrappedUse () {
    if (arguments.length === 0) return use.apply(this, arguments)

    // Get mount argument and use it to register each router against the exact paths Express will use.
    const { mountPaths, startIdx } = extractMountPaths(arguments)
    const pathsToRegister = mountPaths.length ? mountPaths : ['/']

    for (let i = startIdx; i < arguments.length; i++) {
      const router = arguments[i]

      if (!router || typeof router !== 'function') continue

      markAppMounted(router)

      // Avoid enumerating routes for routers that contain cycles.
      // Express will refuse those at runtime, but collecting them here could loop forever.
      let skipCollection = false
      if (routeAddedChannel.hasSubscribers) {
        skipCollection = hasRouterCycle(router)
      }

      for (const mountPath of pathsToRegister) {
        const normalizedMountPath = mountPath || '/'
        setRouterMountPath(router, normalizedMountPath)

        if (!skipCollection && routeAddedChannel.hasSubscribers) {
          collectRoutesFromRouter(router, normalizedMountPath)
        }
      }
    }

    return use.apply(this, arguments)
  }
}

// Recursively publish every route reachable from the router.
function collectRoutesFromRouter (router, prefix) {
  if (!router?.stack?.length) return

  for (const layer of router.stack) {
    if (layer.route) {
      // This layer has a direct route
      const route = layer.route

      const fullPaths = getRouteFullPaths(route, prefix)

      for (const fullPath of fullPaths) {
        for (const [method, enabled] of Object.entries(route.methods || {})) {
          if (!enabled) continue
          routeAddedChannel.publish({
            method: normalizeMethodName(method),
            path: fullPath
          })
        }
      }
    } else if (layer.handle?.stack?.length) {
      // This layer contains a nested router
      // Extract mount path from layer
      const mountPath = typeof layer.path === 'string'
        ? layer.path
        : getLayerMatchers(layer)?.[0]?.path || ''

      const nestedPrefix = joinPath(prefix, mountPath)
      // Set the mount path for the nested router
      setRouterMountPath(layer.handle, nestedPrefix)
      markAppMounted(layer.handle)
      // Recursively collect from nested routers
      collectRoutesFromRouter(layer.handle, nestedPrefix)
    }
  }
}

addHook({ name: 'express', versions: ['>=4'], file: ['lib/express.js'] }, express => {
  shimmer.wrap(express.application, 'handle', wrapHandle)
  shimmer.wrap(express.application, 'all', wrapAppAll)
  shimmer.wrap(express.application, 'route', wrapAppRoute)
  shimmer.wrap(express.application, 'use', wrapAppUse)

  shimmer.wrap(express.response, 'json', wrapResponseJson)
  shimmer.wrap(express.response, 'jsonp', wrapResponseJson)
  shimmer.wrap(express.response, 'render', wrapResponseRender)

  return express
})

// Express 5 does not rely on router in the same way as v4 and should not be instrumented anymore.
// It would otherwise produce spans for router and express, and so duplicating them.
// We now fall back to router instrumentation
addHook({ name: 'express', versions: ['4'], file: 'lib/express.js' }, express => {
  shimmer.wrap(express.Router, 'use', wrapRouterMethod)
  shimmer.wrap(express.Router, 'route', wrapRouterMethod)

  return express
})

const queryParserReadCh = channel('datadog:query:read:finish')

function publishQueryParsedAndNext (req, res, next) {
  return shimmer.wrapFunction(next, next => function () {
    if (queryParserReadCh.hasSubscribers && req) {
      const abortController = new AbortController()
      const query = req.query

      queryParserReadCh.publish({ req, res, query, abortController })

      if (abortController.signal.aborted) return
    }

    return next.apply(this, arguments)
  })
}

addHook({
  name: 'express',
  versions: ['4'],
  file: 'lib/middleware/query.js'
}, query => {
  return shimmer.wrapFunction(query, query => function () {
    const queryMiddleware = query.apply(this, arguments)

    return shimmer.wrapFunction(queryMiddleware, queryMiddleware => function (req, res, next) {
      arguments[2] = publishQueryParsedAndNext(req, res, next)
      return queryMiddleware.apply(this, arguments)
    })
  })
})

const processParamsStartCh = channel('datadog:express:process_params:start')
function wrapProcessParamsMethod (requestPositionInArguments) {
  return function wrapProcessParams (original) {
    return function wrappedProcessParams () {
      if (processParamsStartCh.hasSubscribers) {
        const req = arguments[requestPositionInArguments]
        const abortController = new AbortController()

        processParamsStartCh.publish({
          req,
          res: req?.res,
          abortController,
          params: req?.params
        })

        if (abortController.signal.aborted) return
      }

      return original.apply(this, arguments)
    }
  }
}

addHook({ name: 'express', versions: ['>=4.0.0 <4.3.0'], file: ['lib/express.js'] }, express => {
  shimmer.wrap(express.Router, 'process_params', wrapProcessParamsMethod(1))
  return express
})

addHook({ name: 'express', versions: ['>=4.3.0 <5.0.0'], file: ['lib/express.js'] }, express => {
  shimmer.wrap(express.Router, 'process_params', wrapProcessParamsMethod(2))
  return express
})

const queryReadCh = channel('datadog:express:query:finish')

addHook({ name: 'express', file: ['lib/request.js'], versions: ['>=5.0.0'] }, request => {
  shimmer.wrap(request, 'query', function (originalGet) {
    return function wrappedGet () {
      const query = originalGet.call(this)

      if (queryReadCh.hasSubscribers && query) {
        queryReadCh.publish({ query })
      }

      return query
    }
  })

  return request
})
