'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  addHook,
  channel
} = require('./helpers/instrument')

const routeChannel = channel('apm:hono:request:route')
const handleChannel = channel('apm:hono:request:handle')
const errorChannel = channel('apm:hono:request:error')
const nextChannel = channel('apm:hono:middleware:next')
const enterChannel = channel('apm:hono:middleware:enter')
const exitChannel = channel('apm:hono:middleware:exit')
const finishChannel = channel('apm:hono:middleware:finish')

function wrapFetch (fetch) {
  return function (request, env, executionCtx) {
    handleChannel.publish({ req: env.incoming })
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
              (err) => {
                errorChannel.publish({ req, error: err })
                throw err
              }
            )
          }
          finishChannel.publish({ req })
          return result
        } catch (e) {
          errorChannel.publish({ req, error: e })
          throw e
        } finally {
          exitChannel.publish({ req, route })
        }
      }
  )
}

addHook({
  name: 'hono',
  versions: ['>=4'],
  file: 'dist/hono.js'
}, hono => {
  class Hono extends hono.Hono {
    constructor (...args) {
      super(...args)
      shimmer.wrap(this, 'fetch', wrapFetch)
    }
  }

  hono.Hono = Hono

  return hono
})

addHook({
  name: 'hono',
  versions: ['>=4'],
  file: 'dist/cjs/hono.js'
}, hono => {
  class Hono extends hono.Hono {
    constructor (...args) {
      super(...args)
      shimmer.wrap(this, 'fetch', wrapFetch)
    }
  }

  return Object.create(hono, {
    Hono: {
      get () {
        return Hono
      },
      enumerable: true,
    }
  })
})

addHook({
  name: 'hono',
  versions: ['>=4'],
  file: 'dist/cjs/compose.js'
}, Compose => {
  return shimmer.wrap(Compose, 'compose', wrapCompose, { replaceGetter: true })
})

addHook({
  name: 'hono',
  versions: ['>=4'],
  file: 'dist/compose.js'
}, Compose => {
  return shimmer.wrap(Compose, 'compose', wrapCompose)
})
