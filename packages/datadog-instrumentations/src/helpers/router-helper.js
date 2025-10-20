'use strict'

const { channel } = require('./instrument')
const shimmer = require('../../../datadog-shimmer')

const routerMountPaths = new WeakMap() // to track mount paths for router instances
const layerMatchers = new WeakMap() // to store layer matchers
const appMountedRouters = new WeakSet() // to track routers mounted via app.use()

const METHODS = [...require('http').METHODS.map(v => v.toLowerCase()), 'all']

const routeAddedChannel = channel('apm:express:route:added')

function joinPath (base, path) {
  if (!base || base === '/') return path || '/'
  if (!path || path === '/') return base
  if (base.endsWith('/') && path.startsWith('/')) return base + path.slice(1)
  return base + path
}

// Normalize route definitions coming from Express into a string representation
function normalizeRoutePath (path) {
  if (path == null) return null
  if (typeof path === 'string') return path
  if (path instanceof RegExp) return path.toString()

  return String(path)
}

// Recursively publish every route reachable from the router.
function collectRoutesFromRouter (router, prefix) {
  if (!router?.stack?.length) return

  for (const layer of router.stack) {
    if (layer.route) {
      // This layer has a direct route
      const route = layer.route

      const fullPaths = getRouteFullPaths(route, prefix)

      for (const fullPath of fullPaths) {
        for (const [method, enabled] of Object.entries(route.methods || {})) {
          if (!enabled) continue
          routeAddedChannel.publish({
            method: normalizeMethodName(method),
            path: fullPath
          })
        }
      }
    } else if (layer.handle?.stack?.length) {
      // This layer contains a nested router
      // Extract mount path from layer
      const mountPath = typeof layer.path === 'string'
        ? layer.path
        : getLayerMatchers(layer)?.[0]?.path || ''

      const nestedPrefix = joinPath(prefix, mountPath)
      // Set the mount path for the nested router
      setRouterMountPath(layer.handle, nestedPrefix)
      markAppMounted(layer.handle)
      // Recursively collect from nested routers
      collectRoutesFromRouter(layer.handle, nestedPrefix)
    }
  }
}

// Flatten any route definition into an array of normalized path strings.
function normalizeRoutePaths (path) {
  if (path == null) return []

  if (Array.isArray(path) === false) {
    const normalized = normalizeRoutePath(path)
    return [normalized]
  }

  const paths = path.flat(Infinity)
  const result = []
  for (const _path of paths) {
    const normalized = normalizeRoutePath(_path)
    if (normalized !== null) {
      result.push(normalized)
    }
  }

  return result
}

function setRouterMountPath (router, mountPath) {
  if (!router || typeof mountPath !== 'string') return
  const existing = routerMountPaths.get(router)
  if (existing) {
    existing.add(mountPath)
  } else {
    routerMountPaths.set(router, new Set([mountPath]))
  }
}

function getRouterMountPaths (router) {
  const paths = routerMountPaths.get(router)
  if (!paths) return []
  return [...paths]
}

function setLayerMatchers (layer, matchers) {
  layerMatchers.set(layer, matchers)
}

function getLayerMatchers (layer) {
  return layerMatchers.get(layer)
}

function normalizeMethodName (method) {
  return method === '_all' || method === 'all' ? '*' : method
}

function getRouteFullPaths (route, prefix) {
  if (!route) return []

  const routePaths = normalizeRoutePaths(route.path)
  const pathsToPublish = routePaths.length ? routePaths : ['']

  return pathsToPublish.map(routePath => joinPath(prefix, routePath))
}

function markAppMounted (router) {
  if (router) appMountedRouters.add(router)
}

function isAppMounted (router) {
  return appMountedRouters.has(router)
}

/**
 * Normalise the optional mount argument provided to app.use()/router.use().
 * Express accepts strings, regex, arrays (possibly nested), or
 * no mount path at all; this helper returns the flattened set of paths along
 * with the index where actual middleware arguments start.
 */
function extractMountPaths (path) {
  const hasMount = typeof path === 'string' || path instanceof RegExp || Array.isArray(path)

  if (!hasMount) {
    return { mountPaths: ['/'], startIdx: 0 }
  }

  const paths = normalizeRoutePaths(path)
  return {
    mountPaths: paths.length ? paths : ['/'],
    startIdx: 1
  }
}

/**
 * Detect cycle router graphs.
 */
function hasRouterCycle (router, stack = new Set()) {
  if (!router?.stack?.length) return false
  if (stack.has(router)) return true

  stack.add(router)

  for (const layer of router.stack) {
    if (!layer?.route && layer?.handle?.stack?.length) {
      const hasCycle = hasRouterCycle(layer.handle, stack)
      if (hasCycle) {
        stack.delete(router)
        return true
      }
    }
  }

  stack.delete(router)
  return false
}

function wrapRouteMethodsAndPublish (route, paths, publish) {
  if (!route || !paths.length) return

  const filteredPaths = paths.filter(Boolean)
  if (!filteredPaths.length) return

  const uniquePaths = [...new Set(filteredPaths)]

  METHODS.forEach(method => {
    if (typeof route[method] !== 'function') return

    shimmer.wrap(route, method, (originalMethod) => function wrappedRouteMethod () {
      const normalizedMethod = normalizeMethodName(method)

      for (const path of uniquePaths) {
        publish({
          method: normalizedMethod,
          path
        })
      }

      return originalMethod.apply(this, arguments)
    })
  })
}

module.exports = {
  setRouterMountPath,
  getRouterMountPaths,
  joinPath,
  setLayerMatchers,
  getLayerMatchers,
  markAppMounted,
  isAppMounted,
  normalizeRoutePath,
  normalizeRoutePaths,
  getRouteFullPaths,
  wrapRouteMethodsAndPublish,
  extractMountPaths,
  hasRouterCycle,
  collectRoutesFromRouter
}
