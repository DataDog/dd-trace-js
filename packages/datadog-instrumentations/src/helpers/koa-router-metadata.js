'use strict'

/** @typedef {{ path: string | RegExp, methods: string[] }} Layer */

/** @type {WeakMap<Function, { original: Function, layer: Layer }>} */
const routerMiddleware = new WeakMap()

/**
 * @param {Layer} [layer]
 */
function middlewareRoute (layer) {
  const path = layer?.path
  return typeof path === 'string' && !path.endsWith('(.*)') && !path.endsWith('([^/]*)') &&
    !path.includes('(?:') && path
}

module.exports = { routerMiddleware, middlewareRoute }
