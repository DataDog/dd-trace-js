'use strict'

/**
 * Route-specificity rules, shared by the router plugin and the native middleware plugin
 * so the two cannot disagree about which of two candidate routes is the real handler.
 * Extracted rather than duplicated: these are heuristics, and a second copy would drift.
 */

/**
 * @param {string} routeA
 * @param {string} routeB
 * @returns {boolean}
 */
function isMoreSpecificThan (routeA, routeB) {
  // Concrete paths beat catch-all wildcards (`/*splat`, `/api/*`) on the same
  // request so that `/foo/bar` wins over `/foo/*splat` regardless of length.
  if (routeA && routeB) {
    const aWild = hasWildcard(routeA)
    const bWild = hasWildcard(routeB)
    if (aWild !== bWild) return !aWild
  }
  if (!routeIsRegex(routeA) && routeIsRegex(routeB)) {
    return true
  }
  return routeA.length > routeB.length
}

function routeIsRegex (route) {
  return route.includes('(/')
}

function hasWildcard (route) {
  // RegExp routes are encoded as `(/.../)` and may legitimately contain `*`,
  // so only treat plain string patterns as wildcards.
  return !routeIsRegex(route) && route.includes('*')
}

/**
 * A middleware layer contributes a path segment on enter and gives it back on `next`.
 * The most specific join seen across the request is the route.
 *
 * @param {{ stack: string[], route: string }} tracker
 * @param {string | undefined} route Raw route from the instrumentation.
 * @returns {string} The tracker's route after this layer.
 */
function enterRoute (tracker, route) {
  if (!route || route === '/' || route === '*') {
    route = ''
  }

  tracker.stack.push(route)
  const joined = tracker.stack.join('')

  if (isMoreSpecificThan(joined, tracker.route)) {
    tracker.route = joined
  }

  return tracker.route
}

module.exports = { enterRoute, isMoreSpecificThan }
