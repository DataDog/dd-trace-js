'use strict'

const web = require('../../../plugins/util/web')

/** @type {WeakMap<string[], string | undefined>} */
const matchedRoutes = new WeakMap()

/** @param {{ req: object, routeOptions?: { url?: string } }} event */
function onRequest ({ req, routeOptions }) {
  // Legacy Fastify versions lack this public API and use an incompatible route grammar.
  if (!routeOptions) return
  const paths = web.getContext(req)?.paths
  // Fastify's built-in 404 handler has no public URL; retain its router declaration when available.
  const route = routeOptions.url ?? paths?.[0]
  if (paths?.length === 1 && paths[0] === route) matchedRoutes.set(paths, route)
}

/** @param {string[]} paths */
function getMatchedRoute (paths) {
  // Another plugin's setRoute creates a new array, so its route cannot reuse the Fastify capture.
  return matchedRoutes.get(paths)
}

module.exports = { onRequest, getMatchedRoute }
