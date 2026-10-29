'use strict'

/**
 * Observe user writes after plugin initialization without changing the config's identity.
 *
 * @param {object} config
 * @param {Function} onChange
 */
module.exports = function observeRetryConfig (config, onChange) {
  const descriptor = Object.getOwnPropertyDescriptor(config, 'retries')
  if (!descriptor?.configurable || !descriptor.writable) return

  let current = config.retries
  let active = true
  let generation = 0
  let proxies = new WeakMap()
  const targets = new WeakMap()
  const ownsProperty = () => Object.getOwnPropertyDescriptor(config, 'retries')?.get === getRetries
  const unwrap = value => targets.get(value) || value
  const record = version => {
    if (active && version === generation && ownsProperty()) onChange(current)
  }
  const wrap = value => {
    if (value === null || typeof value !== 'object') return value
    if (proxies.has(value)) return proxies.get(value)
    const version = generation
    const proxy = new Proxy(value, {
      get (target, key, receiver) {
        const result = Reflect.get(target, key, receiver)
        const property = Object.getOwnPropertyDescriptor(target, key)
        // Frozen values must be returned unchanged to preserve Proxy invariants.
        return property && !property.configurable && !property.writable && 'value' in property
          ? result
          : wrap(result)
      },
      set (target, key, value) {
        const result = Reflect.set(target, key, unwrap(value))
        if (result) record(version)
        return result
      },
      deleteProperty (target, key) {
        const result = Reflect.deleteProperty(target, key)
        if (result) record(version)
        return result
      },
      defineProperty (target, key, property) {
        const result = Reflect.defineProperty(target, key, 'value' in property
          ? { ...property, value: unwrap(property.value) }
          : property)
        if (result) record(version)
        return result
      },
    })
    proxies.set(value, proxy)
    targets.set(proxy, value)
    return proxy
  }
  function getRetries () {
    return wrap(current)
  }
  Object.defineProperty(config, 'retries', {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    get: getRetries,
    set (value) {
      current = unwrap(value)
      generation++
      proxies = new WeakMap()
      record(generation)
    },
  })

  // Cypress serializes the actual setupNodeEvents return value through this reply.
  // Observing it before serialization also handles a fresh partial return when the
  // manual plugin was loaded inside an already-running setup callback.
  const originalSend = process.send
  let sendObserver
  let ipcActive = true
  const stopIpc = () => {
    ipcActive = false
    if (sendObserver && process.send === sendObserver) process.send = originalSend
    sendObserver = undefined
  }
  if (typeof originalSend === 'function') {
    sendObserver = function (message) {
      if (ipcActive &&
        (message?.event === 'setupTestingType:reply' || message?.event === 'setupTestingType:error')) {
        try {
          const returnedConfig = message.event === 'setupTestingType:reply' && message.args?.[0]?.setupConfig
          if (active && ownsProperty() && returnedConfig &&
            Object.hasOwn(returnedConfig, 'retries') && returnedConfig.retries !== config.retries) {
            onChange(returnedConfig.retries)
          }
        } finally {
          stopIpc()
        }
      }
      return originalSend.apply(this, arguments)
    }
    process.send = sendObserver
  }

  return {
    isWatching: candidate => active && candidate === config && ownsProperty(),
    stopIpc,
    stop () {
      active = false
      stopIpc()
      if (ownsProperty()) Object.defineProperty(config, 'retries', { ...descriptor, value: current })
    },
  }
}
