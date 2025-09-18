'use strict'

const { createWrapRouterMethod } = require('./router')
const shimmer = require('../../datadog-shimmer')
const { addHook, channel, tracingChannel } = require('./helpers/instrument')

const METHODS = require('http').METHODS.map(v => v.toLowerCase())

const handleChannel = channel('apm:express:request:handle')
const routeAddedChannel = channel('apm:express:add:route')

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
    if (routeAddedChannel.hasSubscribers) {
      const paths = Array.isArray(path) ? path : [path]

      for (const p of paths) {
        routeAddedChannel.publish({
          method: '*',
          path: p instanceof RegExp ? p.toString() : p
        })
      }
    }

    return all.apply(this, arguments)
  }
}

// Wrap app.route() to instrument Route object
function wrapAppRoute (route) {
  return function wrappedRoute (path) {
    const routeObj = route.apply(this, arguments)

    if (routeAddedChannel.hasSubscribers && typeof path === 'string') {
      // Wrap each HTTP method
      ['all', ...METHODS].forEach(method => {
        if (typeof routeObj[method] === 'function') {
          shimmer.wrap(routeObj, method, (original) => function wrapMethod () {
            routeAddedChannel.publish({
              method: method === 'all' ? '*' : method,
              path
            })

            return original.apply(this, arguments)
          })
        }
      })
    }

    return routeObj
  }
}

function joinPath (base, path) {
  if (!base || base === '/') return path || '/'
  if (!path || path === '/') return base
  return base + path
}

function wrapAppUse (use) {
  return function wrappedUse () {
    if (arguments.length < 2) {
      return use.apply(this, arguments)
    }

    // Check if second argument has a stack (likely a router)
    const mountPath = arguments[0]
    const router = arguments[1]

    if (typeof mountPath === 'string' && router?.stack?.length && routeAddedChannel.hasSubscribers) {
      collectRoutesFromRouter(router, mountPath)
    }

    return use.apply(this, arguments)
  }
}

function collectRoutesFromRouter (router, prefix) {
  if (!router?.stack?.length) return

  router.stack.forEach(layer => {
    if (layer.route) {
      // This layer has a direct route
      const route = layer.route
      const fullPath = joinPath(prefix, route.path)

      for (const [method, enabled] of Object.entries(route.methods)) {
        if (!enabled) continue
        routeAddedChannel.publish({
          method: method === '_all' ? '*' : method,
          path: fullPath
        })
      }
    } else if (layer.handle?.stack?.length) {
      // This layer contains a nested router
      // Prefer matchers (from router.js) when available to resolve the exact mount path
      const matchers = layer.ddMatchers
      const mountPath = (Array.isArray(matchers) && matchers.length) ? matchers[0].path : ''

      const nestedPrefix = joinPath(prefix, mountPath)
      collectRoutesFromRouter(layer.handle, nestedPrefix)
    }
  })
}

addHook({ name: 'express', versions: ['>=4'] }, express => {
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
addHook({ name: 'express', versions: ['4'] }, express => {
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

addHook({ name: 'express', versions: ['>=4.0.0 <4.3.0'] }, express => {
  shimmer.wrap(express.Router, 'process_params', wrapProcessParamsMethod(1))
  return express
})

addHook({ name: 'express', versions: ['>=4.3.0 <5.0.0'] }, express => {
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
