'use strict'

const { tracingChannel } = require('dc-polyfill')

const { addHook, getHooks } = require('./helpers/instrument')

const requestChannel = tracingChannel('h3.request')
const requestContexts = new WeakMap()

function wrapHandler (handler) {
  if (typeof handler !== 'function' || handler.__dd_traced__ || handler.__traced__) return handler

  const wrapped = function (event) {
    if (!requestChannel.start.hasSubscribers) return handler.apply(this, arguments)

    const ctx = { event, type: 'request' }
    requestContexts.set(event, ctx)

    return requestChannel.start.runStores(ctx, () => {
      try {
        const result = handler.apply(this, arguments)
        if (result && typeof result.then === 'function') {
          return result.catch(error => {
            ctx.error = error
            requestChannel.error.publish(ctx)
            throw error
          })
        }
        return result
      } catch (error) {
        ctx.error = error
        requestChannel.error.publish(ctx)
        throw error
      }
    })
  }
  wrapped.__dd_traced__ = true
  wrapped.__traced__ = true

  return wrapped
}

function wrapOnResponse (app) {
  const originalOnResponse = app.config.onResponse
  if (originalOnResponse?.__dd_traced__) return

  app.config.onResponse = function (response, event) {
    const ctx = requestContexts.get(event)

    if (!ctx) {
      return originalOnResponse?.apply(this, arguments)
    }

    const finish = () => {
      ctx.result = response
      requestChannel.asyncStart.publish(ctx)
      requestChannel.asyncEnd.publish(ctx)
      requestContexts.delete(event)
    }
    const fail = error => {
      ctx.error = error
      requestChannel.error.publish(ctx)
    }

    try {
      const result = originalOnResponse?.apply(this, arguments)
      if (result && typeof result.then === 'function') {
        return result.then(value => {
          finish()
          return value
        }, error => {
          fail(error)
          finish()
          throw error
        })
      }
      finish()
      return result
    } catch (error) {
      fail(error)
      finish()
      throw error
    }
  }
  app.config.onResponse.__dd_traced__ = true
}

function ddTracingPlugin (app) {
  app.handler = wrapHandler(app.handler)
  wrapOnResponse(app)

  if (typeof app.register === 'function' && !app.register.__dd_traced__) {
    const originalRegister = app.register
    app.register = function (...args) {
      const instance = originalRegister.apply(this, args)
      instance.handler = wrapHandler(instance.handler)
      wrapOnResponse(instance)
      return instance
    }
    app.register.__dd_traced__ = true
  }
}

// Orchestrion publishes the freshly constructed H3 instance here.
tracingChannel('orchestrion:h3:H3_constructor').subscribe({
  end (ctx) {
    ctx.self?.register(ddTracingPlugin)
  },
})

for (const hook of getHooks('h3')) {
  addHook(hook, h3Module => h3Module)
}

addHook({ name: 'nitro', versions: ['>=3'] }, nitro => nitro)
