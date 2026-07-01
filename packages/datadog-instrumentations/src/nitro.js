'use strict'

const { tracingChannel } = require('dc-polyfill')

const { addHook, getHooks } = require('./helpers/instrument')

// h3 has its own h3.request tracing plugin, but it is ESM-only and replaces
// route objects after rou3 has stored them. Register here and mutate handlers in
// place so h3's route table and dispatch trie stay aligned.
const requestChannel = tracingChannel('h3.request')

function wrapHandler (handler) {
  if (typeof handler !== 'function' || handler.__dd_traced__ || handler.__traced__) return handler

  // Match h3's plugin: sync throws become promise rejections reported by tracePromise.
  const wrapped = (...args) => requestChannel.tracePromise(
    async () => await handler(...args),
    { event: args[0], type: 'route' }
  )
  wrapped.__dd_traced__ = true
  wrapped.__traced__ = true

  return wrapped
}

function ddTracingPlugin (app) {
  for (const route of app['~routes'] ?? []) {
    route.handler = wrapHandler(route.handler)
  }

  if (typeof app.on === 'function') {
    const originalOn = app.on
    app.on = function (...args) {
      const instance = originalOn.apply(this, args)
      const routes = instance['~routes']
      const lastRoute = routes?.[routes.length - 1]
      if (lastRoute) lastRoute.handler = wrapHandler(lastRoute.handler)
      return instance
    }
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
