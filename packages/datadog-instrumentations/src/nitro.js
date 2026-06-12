'use strict'

const { tracingChannel } = require('dc-polyfill')

const { addHook, getHooks } = require('./helpers/instrument')

// h3 v2 exposes a native `tracingChannel('h3.request')` that NitroPlugin
// subscribes to (see packages/datadog-plugin-nitro/src/index.js), but the
// handlers only publish to it once h3's tracing plugin has wrapped them.
//
// We register our own equivalent plugin rather than h3's ESM-only
// `dist/tracing.mjs` export for two reasons:
//   1. It is ESM-only, so it cannot be `require()`d synchronously on every
//      supported Node version, and registration must happen synchronously at
//      construction time (see below).
//   2. h3's plugin re-wraps already-registered routes by replacing the
//      `~routes` array with new objects, which leaves the `rou3` routing trie
//      (where requests are actually dispatched) pointing at the original,
//      unwrapped handlers. Mutating the handler in place keeps the trie and the
//      `~routes` array in sync.
const requestChannel = tracingChannel('h3.request')

/**
 * Wraps an h3 route handler so its execution is traced via `h3.request`.
 *
 * Guards against double wrapping: skips handlers already wrapped by us
 * (`__dd_traced__`) or by h3's own `tracingPlugin` (`__traced__`), and marks the
 * wrapped handler with both so neither side wraps it a second time (which would
 * publish to `h3.request` twice and produce duplicate spans per request).
 *
 * @param {Function} handler - The original h3 route handler.
 * @returns {Function} The traced handler (or the original if already traced).
 */
function wrapHandler (handler) {
  if (typeof handler !== 'function' || handler.__dd_traced__ || handler.__traced__) return handler

  // `async` so a handler that throws synchronously becomes a rejection that
  // tracePromise reports through the error/asyncEnd events (matching h3's own
  // tracingPlugin), rather than throwing straight out of the channel.
  const wrapped = (...args) => requestChannel.tracePromise(
    async () => await handler(...args),
    { event: args[0], type: 'route' }
  )
  wrapped.__dd_traced__ = true
  wrapped.__traced__ = true

  return wrapped
}

/**
 * h3 plugin that traces route handlers. Registered at construction time so that
 * every route added afterwards is wrapped in place (keeping the `rou3` trie and
 * the `~routes` array in sync).
 *
 * @param {object} app - The H3 application instance.
 */
function ddTracingPlugin (app) {
  // Wrap any routes that already exist (none at construction, but safe if the
  // plugin is ever registered after routes have been added).
  for (const route of app['~routes'] ?? []) {
    route.handler = wrapHandler(route.handler)
  }

  // Wrap handlers for routes registered after the plugin. `all`/`get`/`post`/...
  // all funnel through `on`, so wrapping `on` covers every route registration.
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

// The orchestrion rewriter (see helpers/rewriter/instrumentations/h3.js) injects
// this tracing channel into the `H3` constructor. `ctx.self` is the freshly
// constructed instance, available before any route is registered.
tracingChannel('orchestrion:h3:H3_constructor').subscribe({
  end (ctx) {
    ctx.self?.register(ddTracingPlugin)
  },
})

for (const hook of getHooks('h3')) {
  addHook(hook, h3Module => h3Module)
}

addHook({ name: 'nitro', versions: ['>=3'] }, nitro => nitro)
