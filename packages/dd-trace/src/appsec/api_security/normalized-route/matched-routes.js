'use strict'

const web = require('../../../plugins/util/web')

/** @type {WeakMap<string[], string | undefined>} */
const matchedRoutes = new WeakMap()

/** @param {{ req: object, routeOptions?: { url?: string } }} event */
function onRequest ({ req, routeOptions }) {
  // Legacy Fastify and unmatched requests have no public route declaration.
  const route = routeOptions?.url
  if (typeof route !== 'string') return
  const paths = web.getContext(req)?.paths
  if (paths?.length === 1 && paths[0] === route) matchedRoutes.set(paths, route)
}

/** @param {string[]} paths */
function getMatchedRoute (paths) {
  // Another plugin's setRoute creates a new array, so its route cannot reuse the Fastify capture.
  return matchedRoutes.get(paths)
}

module.exports = { onRequest, getMatchedRoute }
