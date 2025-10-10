'use strict'

const shimmer = require('../../../datadog-shimmer')

const routerMountPaths = new WeakMap() // to track mount paths for router instances
const layerMatchers = new WeakMap() // to store layer matchers
const appMountedRouters = new WeakSet() // to track routers mounted via app.use()

const METHODS = [...require('http').METHODS.map(v => v.toLowerCase()), 'all']

function joinPath (base, path) {
  if (!base || base === '/') return path || '/'
  if (!path || path === '/') return base
  if (base.endsWith('/') && path.startsWith('/')) return base + path.slice(1)
  return base + path
}

// Normalize route definitions coming from Express into a string representation
function normalizeRoutePath (path) {
  if (path == null) return null
  if (path instanceof RegExp) return path.toString()
  if (typeof path === 'string') return path

  return String(path)
}

// Flatten any route definition into an array of normalized path strings.
function normalizeRoutePaths (path) {
  const queue = Array.isArray(path) ? [...path] : [path]
  const paths = []

  while (queue.length) {
    const current = queue.shift()

    if (Array.isArray(current)) {
      queue.unshift(...current)
      continue
    }

    const normalized = normalizeRoutePath(current)

    if (normalized !== null) {
      paths.push(normalized)
    }
  }

  return paths
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
function extractMountPaths (args) {
  const firstArg = args[0]
  const hasMount = typeof firstArg === 'string' || firstArg instanceof RegExp || Array.isArray(firstArg)

  if (!hasMount) {
    return { mountPaths: ['/'], startIdx: 0 }
  }

  const paths = normalizeRoutePaths(firstArg)
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
  if (!route || !paths?.length || typeof publish !== 'function') return

  const uniquePaths = [...new Set(paths.filter(Boolean))]
  if (!uniquePaths.length) return

  METHODS.forEach(method => {
    if (typeof route[method] !== 'function') return

    shimmer.wrap(route, method, (originalMethod) => function wrappedRouteMethod () {
      for (const path of uniquePaths) {
        publish({
          method: normalizeMethodName(method),
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
  normalizeMethodName,
  markAppMounted,
  isAppMounted,
  normalizeRoutePath,
  normalizeRoutePaths,
  getRouteFullPaths,
  wrapRouteMethodsAndPublish,
  extractMountPaths,
  hasRouterCycle
}
