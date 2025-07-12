'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  addHook,
  channel
} = require('./helpers/instrument')

const routeChannel = channel('apm:hono:request:route')
const handleChannel = channel('apm:hono:request:handle')
const errorChannel = channel('apm:hono:request:error')

function wrapFetch (fetch) {
  return function (request, env, executionCtx) {
    handleChannel.publish({ req: env.incoming })
    return fetch.apply(this, arguments)
  }
}

function wrapCompose (compose) {
  return function (middleware, onError, onNotFound) {
    const instrumentedOnError = (...args) => {
      const [error, context] = args
      const req = context.env.incoming
      errorChannel.publish({ req, error })
      return onError(...args)
    }

    const instrumentedMiddlewares = middleware.map(h => {
      const [[fn, meta], params] = h

      // TODO: handle middleware instrumentation
      const instrumentedFn = (...args) => {
        const context = args[0]
        const req = context.env.incoming
        const route = meta.path
        routeChannel.publish({
          req,
          route
        })
        return fn(...args)
      }
      return [[instrumentedFn, meta], params]
    })
    return compose.apply(this, [instrumentedMiddlewares, instrumentedOnError, onNotFound])
  }
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
