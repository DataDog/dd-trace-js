'use strict'

const shimmer = require('../../datadog-shimmer')
const log = require('../../dd-trace/src/log')
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

// honoInstance is captured from the constructor so that `getPath` and `router`
// are accessible even when the fetch callback is called without a `this` context
// (node-server calls opts.fetch(req, env) without binding the Hono instance).
function wrapFetch (fetch, honoInstance) {
  return function (request, env, executionCtx) {
    const incoming = env.incoming
    handleChannel.publish({ req: incoming })

    // Hono uses a single-handler fast path (skipping compose()) when only one
    // handler matches a request. Our wrapCompose hook never fires in that case,
    // so the route is never published and the resource name stays as just the
    // HTTP method. Detect this here and publish the route proactively.
    if (routeChannel.hasSubscribers) {
      try {
        const method = request.method === 'HEAD' ? 'GET' : request.method
        const path = honoInstance.getPath(request, { env })
        const matchResult = honoInstance.router.match(method, path)
        if (matchResult[0].length === 1) {
          const meta = matchResult[0][0][0][1]
          // Skip middleware-only matches (method === 'ALL'); only publish for real route handlers
          if (meta?.method !== 'ALL') {
            routeChannel.publish({ req: incoming, route: meta?.path })
          }
        }
      } catch (e) {
        log.error('hono: error detecting single-handler route: %s', e.message)
      }
    }

    return fetch.apply(this, arguments)
  }
}

function onErrorFn (error, _context_) {
  throw error
}

function wrapCompose (compose) {
  return function (middlewares, onError, onNotFound) {
    onError ??= onErrorFn

    const instrumentedOnError = (...args) => {
      const [error, context] = args
      const req = context.env.incoming
      errorChannel.publish({ req, error })
      return onError(...args)
    }

    const instrumentedMiddlewares = middlewares.map(h => {
      const [[fn, meta], params] = h
      return [[wrapMiddleware(fn, meta?.path), meta], params]
    })
    return compose.call(this, instrumentedMiddlewares, instrumentedOnError, onNotFound)
  }
}

function wrapNext (req, route, next) {
  return shimmer.wrapFunction(
    next,
    (next) =>
      function () {
        nextChannel.publish({ req, route })

        return next.apply(this, arguments)
      }
  )
}

function wrapMiddleware (middleware, route) {
  const name = middleware.name
  return shimmer.wrapFunction(
    middleware,
    (middleware) =>
      function (context, next) {
        const req = context.env.incoming
        routeChannel.publish({ req, route })
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
      shimmer.wrap(this, 'fetch', (fetch) => wrapFetch(fetch, this))
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
      shimmer.wrap(this, 'fetch', (fetch) => wrapFetch(fetch, this))
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
