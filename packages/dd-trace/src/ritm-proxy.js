'use strict'

function bindOrProxy (target, proxy, mod) {
  if (!target) return target

  if (typeof target === 'object') {
    return getProxyModule(target, mod)

    // NOTE: should it exclude classes function?
  } else if (!isClass(target)) {
    // NOTE: is ok to change thisArg for a module function??
    // NOTE: should check if target isBindable?
    return target.bind(proxy)
  }

  return target
}

const proxyCache = new WeakMap()

function getProxyModule (target, mod) {
  if (!target) return target

  let targetMap = proxyCache.get(target)
  if (targetMap?.has(mod)) {
    return targetMap.get(mod)
  }

  const proxy = new Proxy(target, {
    get (target, key, receiver) {
      return key === '__getCallerModule' ? () => mod : bindOrProxy(target[key], receiver, mod)
    }
  })

  if (!targetMap) {
    targetMap = new WeakMap()
    proxyCache.set(target, targetMap)
  }

  targetMap.set(mod, proxy)

  return proxy
}

function isClass (target) {
  return typeof target === 'function' && Function.prototype.toString.call(target).startsWith('class')
}

module.exports = {
  getProxyModule
}
