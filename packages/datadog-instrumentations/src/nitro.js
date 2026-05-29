'use strict'

const dc = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')

const { addHook } = require('./helpers/instrument')

// h3 v2 publishes TracingChannel events under the static name 'h3.request'.
// These channels only publish when h3's tracingPlugin is registered on an
// app instance. Nitro v3 will register it automatically when the user sets
// `tracingChannel: { h3: true }` in nitro config, but we register it
// unconditionally so dd-trace works out-of-the-box. See:
// https://github.com/h3js/h3/blob/v2/src/tracing.ts
const h3RequestChannel = dc.tracingChannel('h3.request')

/**
 * Wraps an h3 handler/middleware so that its invocation is published on the
 * shared `h3.request` tracing channel. This mirrors the behavior of h3's
 * own `tracingPlugin` and is safe to apply multiple times via the
 * `__dd_traced__` guard.
 *
 * @param {Function} handler
 * @param {string} type - 'route' or 'middleware'
 * @returns {Function}
 */
function wrapH3Handler (handler, type) {
  if (typeof handler !== 'function' || handler.__dd_traced__) return handler

  const wrapped = function (...args) {
    if (!h3RequestChannel.start.hasSubscribers) {
      return handler.apply(this, args)
    }
    return h3RequestChannel.tracePromise(
      () => handler.apply(this, args),
      { event: args[0], type }
    )
  }
  wrapped.__dd_traced__ = true
  return wrapped
}

/**
 * Applies the dd-trace h3 tracing plugin to an H3 instance: it wraps existing
 * middleware/routes and intercepts future `on`/`use`/`mount` calls so all
 * handlers publish channel events.
 *
 * @param {object} h3 - h3 app instance
 */
function applyH3Tracing (h3) {
  if (!h3 || h3.__dd_traced__) return
  h3.__dd_traced__ = true

  // Wrap any pre-registered middleware/routes
  if (Array.isArray(h3['~middleware'])) {
    h3['~middleware'] = h3['~middleware'].map(m => wrapH3Handler(m, 'middleware'))
  }
  if (Array.isArray(h3['~routes'])) {
    h3['~routes'] = h3['~routes'].map(route => ({
      ...route,
      handler: wrapH3Handler(route.handler, 'route'),
      middleware: Array.isArray(route.middleware)
        ? route.middleware.map(m => wrapH3Handler(m, 'middleware'))
        : route.middleware,
    }))
  }

  if (typeof h3.on === 'function') {
    shimmer.wrap(h3, 'on', original => function (...args) {
      const instance = original.apply(this, args)
      const routes = instance && instance['~routes']
      if (Array.isArray(routes) && routes.length > 0) {
        const last = routes[routes.length - 1]
        last.handler = wrapH3Handler(last.handler, 'route')
        if (Array.isArray(last.middleware)) {
          last.middleware = last.middleware.map(m => wrapH3Handler(m, 'middleware'))
        }
      }
      return instance
    })
  }

  if (typeof h3.use === 'function') {
    shimmer.wrap(h3, 'use', original => function (arg1, arg2, arg3) {
      if (typeof arg1 === 'string') {
        return original.call(this, arg1, wrapH3Handler(arg2, 'middleware'), arg3)
      }
      return original.call(this, wrapH3Handler(arg1, 'middleware'), arg2)
    })
  }
}

/**
 * Wraps the H3 class constructor to auto-apply tracing on every instance.
 * @param {Function} H3
 * @returns {Function}
 */
function wrapH3Class (H3) {
  if (typeof H3 !== 'function' || H3.__dd_wrapped__) return H3
  const Wrapped = function (...args) {
    const instance = Reflect.construct(H3, args, new.target || Wrapped)
    try {
      applyH3Tracing(instance)
    } catch {
      // Never break user code if the wrapping fails.
    }
    return instance
  }
  Wrapped.prototype = H3.prototype
  Wrapped.__dd_wrapped__ = true
  Object.setPrototypeOf(Wrapped, H3)
  return Wrapped
}

addHook({ name: 'h3', versions: ['>=2'] }, h3 => {
  if (h3 && typeof h3.H3 === 'function') {
    shimmer.wrap(h3, 'H3', wrapH3Class)
  }
  if (h3 && typeof h3.createApp === 'function') {
    shimmer.wrap(h3, 'createApp', original => function (...args) {
      const app = original.apply(this, args)
      applyH3Tracing(app)
      return app
    })
  }
  return h3
})

// Nitro re-exports h3 internally; hooking nitro keeps the integration
// discoverable (i.e. plugin is registered) when only nitro is required.
addHook({ name: 'nitro', versions: ['>=3'] }, nitro => nitro)
