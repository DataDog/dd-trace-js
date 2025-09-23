'use strict'

const routerMountPaths = new WeakMap() // to track mount paths for router instances
const layerMatchers = new WeakMap() // to store layer matchers
const appMountedRouters = new WeakSet() // to track routers mounted via app.use()

function joinPath (base, path) {
  if (!base || base === '/') return path || '/'
  if (!path || path === '/') return base
  return base + path
}

function setRouterMountPath (router, mountPath) {
  if (!router || typeof mountPath !== 'string') return
  routerMountPaths.set(router, mountPath)
}

function getRouterMountPath (router) {
  return routerMountPaths.get(router) || ''
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

function markAppMounted (router) {
  if (router) appMountedRouters.add(router)
}

function isAppMounted (router) {
  return appMountedRouters.has(router)
}

module.exports = {
  setRouterMountPath,
  getRouterMountPath,
  joinPath,
  setLayerMatchers,
  getLayerMatchers,
  normalizeMethodName,
  markAppMounted,
  isAppMounted
}
