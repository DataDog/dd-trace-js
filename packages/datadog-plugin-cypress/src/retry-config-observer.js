'use strict'

/**
 * Observe user writes after plugin initialization without changing the config's identity.
 *
 * @param {object} config
 * @param {Function} onChange
 * @param {{ nativeRetries: unknown, updateNative: Function }} [options]
 */
module.exports = function observeRetryConfig (config, onChange, options) {
  const descriptor = Object.getOwnPropertyDescriptor(config, 'retries')
  if (!descriptor?.configurable || !descriptor.writable) return

  let current = config.retries
  let active = true
  const roots = new WeakMap()
  const targets = new WeakMap()
  const ownsProperty = () => Object.getOwnPropertyDescriptor(config, 'retries')?.get === getRetries
  const unwrap = value => targets.get(value) || value
  const notify = (value, path, metadata) => {
    const provenance = options && {
      retries: metadata ? metadata.native : options.updateNative(undefined, value, []),
    }
    onChange(value, path, provenance)
  }
  const getRoot = (raw, native) => {
    if (!raw || typeof raw !== 'object') return
    if (roots.has(raw)) return roots.get(raw)
    const metadata = { raw, native, proxies: new WeakMap() }
    roots.set(raw, metadata)
    return metadata
  }
  getRoot(current, options?.nativeRetries)
  const record = (metadata, path) => {
    if (!active || !ownsProperty()) return
    if (options) metadata.native = options.updateNative(metadata.native, metadata.raw, path)
    // A detached alias updates only its own provenance until that root is selected again.
    if (metadata.raw === current) notify(current, path, metadata)
  }
  const wrap = (value, metadata, path = []) => {
    if (value === null || typeof value !== 'object') return value
    if (metadata.proxies.has(value)) return metadata.proxies.get(value)
    const proxy = new Proxy(value, {
      get (target, key, receiver) {
        const result = Reflect.get(target, key, receiver)
        const property = Object.getOwnPropertyDescriptor(target, key)
        // Frozen values must be returned unchanged to preserve Proxy invariants.
        return property && !property.configurable && !property.writable && 'value' in property
          ? result
          : wrap(result, metadata, [...path, key])
      },
      set (target, key, value) {
        const result = Reflect.set(target, key, unwrap(value))
        if (result) record(metadata, [...path, key])
        return result
      },
      deleteProperty (target, key) {
        const result = Reflect.deleteProperty(target, key)
        if (result) record(metadata, [...path, key])
        return result
      },
      defineProperty (target, key, property) {
        const result = Reflect.defineProperty(target, key, 'value' in property
          ? { ...property, value: unwrap(property.value) }
          : property)
        if (result) record(metadata, [...path, key])
        return result
      },
    })
    metadata.proxies.set(value, proxy)
    targets.set(proxy, value)
    return proxy
  }
  function getRetries () {
    return wrap(current, getRoot(current))
  }
  Object.defineProperty(config, 'retries', {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    get: getRetries,
    set (value) {
      const next = unwrap(value)
      if (next && typeof next === 'object' && next === current) return
      current = next
      const metadata = getRoot(current, options && options.updateNative(undefined, current, []))
      if (active && ownsProperty()) notify(current, [], metadata)
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
  const stop = () => {
    active = false
    stopIpc()
    if (ownsProperty()) Object.defineProperty(config, 'retries', { ...descriptor, value: current })
  }
  if (typeof originalSend === 'function') {
    sendObserver = function (message) {
      if (ipcActive &&
        (message?.event === 'setupTestingType:reply' || message?.event === 'setupTestingType:error')) {
        try {
          const wireConfig = message.event === 'setupTestingType:reply' && message.args?.[0]?.setupConfig
          const returnedConfig = wireConfig?.[Symbol.for('dd-trace.cypress.returned-config')] ?? wireConfig
          if (active && ownsProperty() && returnedConfig &&
            Object.hasOwn(returnedConfig, 'retries') && returnedConfig.retries !== config.retries) {
            const retries = unwrap(returnedConfig.retries)
            notify(retries, [], retries && typeof retries === 'object' && roots.get(retries))
          }
        } finally {
          // Later child-local writes cannot change the parent's serialized config.
          stop()
        }
      }
      return originalSend.apply(this, arguments)
    }
    process.send = sendObserver
  }

  return {
    isWatching: candidate => active && candidate === config && ownsProperty(),
    stopIpc,
    stop,
  }
}
