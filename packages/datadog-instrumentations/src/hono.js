'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  addHook,
  channel,
} = require('./helpers/instrument')

const routeChannel = channel('apm:hono:request:route')
const handleChannel = channel('apm:hono:request:handle')
const errorChannel = channel('apm:hono:request:error')
const nextChannel = channel('apm:hono:middleware:next')
const enterChannel = channel('apm:hono:middleware:enter')
const exitChannel = channel('apm:hono:middleware:exit')
const finishChannel = channel('apm:hono:middleware:finish')

const middlewareRoutes = new WeakSet()
channel('tracing:orchestrion:hono:middlewareRoute:start').subscribe(({ record, source }) => {
  if (source === true || middlewareRoutes.has(source)) {
    middlewareRoutes.add(record)
  }
})

// `app.request()` and non-node adapters call `app.fetch` without an `incoming`
// IncomingMessage; the APM `web` helpers depend on one, so the wrappers below
// skip publishing whenever it is missing.
function wrapFetch (fetch) {
  return function (request, env, executionCtx) {
    const req = env?.incoming
    if (req) {
      handleChannel.publish({ req })
    }
    return fetch.apply(this, arguments)
  }
}

// `app.basePath()` returns a clone Hono instance built via the library's
// internal class binding, so it never hits our instrumented constructor. The
// clone shares the parent router (so `router.add` stays wrapped), but its
// fresh per-instance methods bypass the parent wraps.
function wrapBasePath (originalBasePath) {
  return function (path) {
    const clone = originalBasePath.apply(this, arguments)
    shimmer.wrap(clone, 'fetch', wrapFetch)
    shimmer.wrap(clone, 'basePath', wrapBasePath)
    return clone
  }
}

function wrapRouterAdd (originalAdd) {
  return function (method, path, handlerData) {
    const handler = handlerData?.[0]
    const meta = handlerData?.[1]
    if (typeof handler === 'function' && !middlewareRoutes.has(meta)) {
      const wrappedHandler = function (context, next) {
        const req = context.env?.incoming
        if (req && routeChannel.hasSubscribers) {
          routeChannel.publish({ req, route: meta?.path })
        }
        return handler.apply(this, arguments)
      }
      handlerData = [wrappedHandler, meta]
    }
    return originalAdd.call(this, method, path, handlerData)
  }
}

function instrumentHonoInstance (instance) {
  shimmer.wrap(instance, 'fetch', wrapFetch)
  shimmer.wrap(instance, 'basePath', wrapBasePath)
  shimmer.wrap(instance.router, 'add', wrapRouterAdd)
}

function onErrorFn (error, _context_) {
  throw error
}

function wrapCompose (compose) {
  return function (middlewares, onError, onNotFound) {
    onError ??= onErrorFn

    const instrumentedOnError = (...args) => {
      const [error, context] = args
      const req = context.env?.incoming
      if (req) {
        errorChannel.publish({ req, error })
      }
      return onError(...args)
    }

    const instrumentedMiddlewares = middlewares.map(h => {
      const [[fn, meta], params] = h
      return [[wrapMiddleware(fn, middlewareRoutes.has(meta) ? undefined : meta?.path), meta], params]
    })
    return compose.call(this, instrumentedMiddlewares, instrumentedOnError, onNotFound)
  }
}

function wrapNext (req, route, next) {
  return shimmer.wrapFunction(
    next,
    (next) =>
      function (...args) {
        nextChannel.publish({ req, route })

        return next.apply(this, args)
      }
  )
}

function wrapMiddleware (middleware, route) {
  const name = middleware.name
  return shimmer.wrapFunction(
    middleware,
    (middleware) =>
      function (context, next) {
        const req = context.env?.incoming
        if (!req) {
          return middleware.apply(this, arguments)
        }
        enterChannel.publish({ req, name, route })
        if (typeof next === 'function') {
          arguments[1] = wrapNext(req, route, next)
        }
        try {
          const result = middleware.apply(this, arguments)
          if (result && typeof result.then === 'function') {
            return result.then(
              (result) => {
                finishChannel.publish({ req })
                return result
              },
              (error) => {
                errorChannel.publish({ req, error })
                throw error
              }
            )
          }
          finishChannel.publish({ req })
          return result
        } catch (error) {
          errorChannel.publish({ req, error })
          throw error
        } finally {
          exitChannel.publish({ req, route })
        }
      }
  )
}

addHook({
  name: 'hono',
  versions: ['>=4'],
  file: 'dist/hono.js',
}, hono => {
  class Hono extends hono.Hono {
    constructor (...args) {
      super(...args)
      instrumentHonoInstance(this)
    }
  }

  hono.Hono = Hono

  return hono
})

addHook({
  name: 'hono',
  versions: ['>=4'],
  file: 'dist/cjs/hono.js',
}, hono => {
  class Hono extends hono.Hono {
    constructor (...args) {
      super(...args)
      instrumentHonoInstance(this)
    }
  }

  return Object.create(hono, {
    Hono: {
      get () {
        return Hono
      },
      enumerable: true,
    },
  })
})

addHook({
  name: 'hono',
  versions: ['>=4'],
  file: 'dist/cjs/compose.js',
}, Compose => {
  return shimmer.wrap(Compose, 'compose', wrapCompose, { replaceGetter: true })
})

addHook({
  name: 'hono',
  versions: ['>=4'],
  file: 'dist/compose.js',
}, Compose => {
  return shimmer.wrap(Compose, 'compose', wrapCompose)
})
