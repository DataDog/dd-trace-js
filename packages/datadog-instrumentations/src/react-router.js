'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, channel } = require('./helpers/instrument')

const handleChannel = channel('apm:react-router:request:handle')
const routeChannel = channel('apm:react-router:request:route')
const errorChannel = channel('apm:react-router:request:error')
const loaderStartChannel = channel('apm:react-router:loader:start')
const loaderFinishChannel = channel('apm:react-router:loader:finish')
const loaderErrorChannel = channel('apm:react-router:loader:error')
const actionStartChannel = channel('apm:react-router:action:start')
const actionFinishChannel = channel('apm:react-router:action:finish')
const actionErrorChannel = channel('apm:react-router:action:error')

const DD_INSTRUMENTATION = Symbol.for('dd-trace.react-router.instrumentation')

/**
 * Strip React Router single-fetch `.data` suffixes so pathname matching stays stable.
 *
 * @param {string} pathname
 */
function normalizePathname (pathname) {
  if (typeof pathname !== 'string') return pathname
  return pathname.endsWith('.data') ? pathname.slice(0, -'.data'.length) || '/' : pathname
}

/**
 * @param {string | undefined} pattern
 */
function normalizePattern (pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) return undefined
  return pattern
}

/**
 * Publish route information for the active request so the Express/http span can
 * be tagged with a parameterized React Router pattern (e.g. `/users/:id`).
 *
 * @param {string | undefined} pattern
 * @param {string | undefined} method
 */
function publishRoute (pattern, method) {
  const route = normalizePattern(pattern)
  if (!route || !routeChannel.hasSubscribers) return
  routeChannel.publish({ route, method })
}

/**
 * Wrap a React Router instrumentation handler result promise without async/await.
 *
 * @template T
 * @param {() => Promise<T>} callHandler
 * @param {{
 *   onSuccess?: (result: T) => void,
 *   onError?: (error: Error) => void,
 *   onFinish?: () => void
 * }} hooks
 */
function wrapInstrumentedCall (callHandler, hooks) {
  let result
  try {
    result = callHandler()
  } catch (error) {
    hooks.onError?.(error)
    hooks.onFinish?.()
    throw error
  }

  if (result && typeof result.then === 'function') {
    return result.then(
      (value) => {
        try {
          if (value && value.status === 'error' && value.error) {
            hooks.onError?.(value.error)
          } else {
            hooks.onSuccess?.(value)
          }
        } finally {
          hooks.onFinish?.()
        }
        return value
      },
      (error) => {
        try {
          hooks.onError?.(error)
        } finally {
          hooks.onFinish?.()
        }
        throw error
      }
    )
  }

  try {
    hooks.onSuccess?.(result)
  } finally {
    hooks.onFinish?.()
  }
  return result
}

/**
 * Datadog ServerInstrumentation for React Router Framework Mode.
 * Injected into `build.entry.module.instrumentations` (and the legacy
 * `unstable_instrumentations` export) when `createRequestHandler` runs.
 */
function createDatadogInstrumentation () {
  return {
    [DD_INSTRUMENTATION]: true,
    handler (handler) {
      handler.instrument({
        request (handleRequest, info) {
          if (handleChannel.hasSubscribers) {
            handleChannel.publish({ request: info?.request })
          }

          return wrapInstrumentedCall(handleRequest, {
            onSuccess (result) {
              publishRoute(result?.meta?.pattern, info?.request?.method)
            },
            onError (error) {
              if (errorChannel.hasSubscribers) {
                errorChannel.publish({ error })
              }
            },
          })
        },
      })
    },
    route (route) {
      const routeId = route?.id
      route.instrument({
        loader (callLoader, info) {
          const pattern = normalizePattern(info?.pattern)
          publishRoute(pattern, info?.request?.method)

          if (loaderStartChannel.hasSubscribers) {
            loaderStartChannel.publish({ routeId, pattern, request: info?.request })
          }

          return wrapInstrumentedCall(callLoader, {
            onError (error) {
              if (loaderErrorChannel.hasSubscribers) {
                loaderErrorChannel.publish({ error, routeId, pattern })
              }
            },
            onFinish () {
              if (loaderFinishChannel.hasSubscribers) {
                loaderFinishChannel.publish({ routeId, pattern })
              }
            },
          })
        },
        action (callAction, info) {
          const pattern = normalizePattern(info?.pattern)
          publishRoute(pattern, info?.request?.method)

          if (actionStartChannel.hasSubscribers) {
            actionStartChannel.publish({ routeId, pattern, request: info?.request })
          }

          return wrapInstrumentedCall(callAction, {
            onError (error) {
              if (actionErrorChannel.hasSubscribers) {
                actionErrorChannel.publish({ error, routeId, pattern })
              }
            },
            onFinish () {
              if (actionFinishChannel.hasSubscribers) {
                actionFinishChannel.publish({ routeId, pattern })
              }
            },
          })
        },
      })
    },
  }
}

/**
 * @param {object} moduleExports
 */
function alreadyInjected (moduleExports) {
  const lists = [
    moduleExports?.instrumentations,
    moduleExports?.unstable_instrumentations,
  ]
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (entry && entry[DD_INSTRUMENTATION]) return true
    }
  }
  return false
}

/**
 * Clone a ServerBuild so React Router picks up Datadog's ServerInstrumentation.
 * Supports both stable (`instrumentations`) and legacy (`unstable_instrumentations`) keys.
 *
 * @param {object} build
 */
function injectInstrumentation (build) {
  if (!build || typeof build !== 'object') return build
  if (!build.entry || typeof build.entry !== 'object') return build
  if (!build.entry.module || typeof build.entry.module !== 'object') return build
  if (alreadyInjected(build.entry.module)) return build

  const entryModule = build.entry.module
  const instrumentation = createDatadogInstrumentation()
  const nextModule = { ...entryModule }

  const stable = Array.isArray(entryModule.instrumentations)
    ? entryModule.instrumentations
    : undefined
  const unstable = Array.isArray(entryModule.unstable_instrumentations)
    ? entryModule.unstable_instrumentations
    : undefined

  // Prefer the key the build already uses; otherwise set both so either RR
  // generation can discover the instrumentation.
  if (stable) {
    nextModule.instrumentations = [instrumentation, ...stable]
  } else if (unstable) {
    nextModule.unstable_instrumentations = [instrumentation, ...unstable]
  } else {
    nextModule.instrumentations = [instrumentation]
    nextModule.unstable_instrumentations = [instrumentation]
  }

  return {
    ...build,
    entry: {
      ...build.entry,
      module: nextModule,
    },
  }
}

/**
 * @param {object | (() => object | Promise<object>)} build
 */
function wrapBuild (build) {
  if (typeof build === 'function') {
    return function wrappedBuild () {
      const result = build.apply(this, arguments)
      if (result && typeof result.then === 'function') {
        return result.then(injectInstrumentation)
      }
      return injectInstrumentation(result)
    }
  }
  return injectInstrumentation(build)
}

function wrapCreateRequestHandler (createRequestHandler) {
  return function (build, mode) {
    return createRequestHandler.call(this, wrapBuild(build), mode)
  }
}

// react-router ships conditional development/production entrypoints.
for (const file of [
  'dist/development/index.js',
  'dist/production/index.js',
  'dist/development/index.mjs',
  'dist/production/index.mjs',
]) {
  addHook({
    name: 'react-router',
    versions: ['>=7.9.5'],
    file,
  }, reactRouter => {
    if (reactRouter && typeof reactRouter.createRequestHandler === 'function') {
      shimmer.wrap(reactRouter, 'createRequestHandler', wrapCreateRequestHandler)
    }
    return reactRouter
  })
}

// Fallback for package mains that resolve without a nested file path.
addHook({
  name: 'react-router',
  versions: ['>=7.9.5'],
}, reactRouter => {
  if (reactRouter && typeof reactRouter.createRequestHandler === 'function') {
    shimmer.wrap(reactRouter, 'createRequestHandler', wrapCreateRequestHandler)
  }
  return reactRouter
})

module.exports = {
  createDatadogInstrumentation,
  injectInstrumentation,
  normalizePathname,
  normalizePattern,
  wrapCreateRequestHandler,
  DD_INSTRUMENTATION,
}
