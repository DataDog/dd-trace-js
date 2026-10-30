'use strict'

// Observe the actual setup serialization boundary without retaining ownership of process.send.
module.exports = function observeSetupHandoff (onHandoff, normalizeIdentity = value => value) {
  const originalSend = process.send
  if (typeof originalSend !== 'function') return () => {}
  let active = true
  const stop = () => {
    active = false
    if (process.send === send) process.send = originalSend
  }
  const send = function (message) {
    let forwardedArguments = arguments
    if (active && (message?.event === 'setupTestingType:reply' || message?.event === 'setupTestingType:error')) {
      try {
        let wireConfig = message.event === 'setupTestingType:reply' && message.args?.[0]?.setupConfig
        const snapshots = new WeakMap()
        const originals = new WeakMap()
        const getters = new WeakMap()
        const materialize = value => {
          if (!value || typeof value !== 'object') return value
          const identity = normalizeIdentity(value)
          if (snapshots.has(identity)) return snapshots.get(identity)
          snapshots.set(value, value)
          snapshots.set(identity, value)
          const entries = []
          const keys = new Set()
          let changed = false
          for (const key of Object.keys(value)) {
            const property = Object.getOwnPropertyDescriptor(value, key)
            const accessor = property && !('value' in property)
            const original = accessor ? Reflect.get(value, key, value) : property?.value
            const cached = materialize(original)
            if (accessor) keys.add(key)
            changed ||= accessor || cached !== original
            entries.push([key, cached])
          }
          getters.set(value, keys)
          getters.set(identity, keys)
          if (!changed) return value
          const cached = Array.isArray(value)
            ? Object.assign(new Array(value.length), Object.fromEntries(entries))
            : Object.fromEntries(entries)
          snapshots.set(value, cached)
          snapshots.set(identity, cached)
          originals.set(cached, identity)
          return cached
        }
        const retriesDescriptor = wireConfig && typeof wireConfig === 'object' &&
          Object.getOwnPropertyDescriptor(wireConfig, 'retries')
        if (retriesDescriptor?.enumerable) {
          const original = 'value' in retriesDescriptor ? retriesDescriptor.value : wireConfig.retries
          const cached = materialize(original)
          if (!('value' in retriesDescriptor) || cached !== original) {
            const entries = Object.keys(wireConfig).map(key => [key, key === 'retries' ? cached : wireConfig[key]])
            const clone = Object.fromEntries(entries)
            const metadataKey = Symbol.for('dd-trace.cypress.returned-config')
            const metadata = Object.getOwnPropertyDescriptor(wireConfig, metadataKey)
            if (metadata) Object.defineProperty(clone, metadataKey, metadata)
            wireConfig = clone
            forwardedArguments = [...arguments]
            forwardedArguments[0] = {
              ...message,
              args: [{ ...message.args[0], setupConfig: wireConfig }, ...message.args.slice(1)],
            }
          }
        }
        const returnedConfig = wireConfig?.[Symbol.for('dd-trace.cypress.returned-config')] ?? wireConfig
        const returnedDescriptor = returnedConfig && typeof returnedConfig === 'object' &&
          Object.getOwnPropertyDescriptor(returnedConfig, 'retries')
        let observedConfig
        if (returnedDescriptor?.enumerable) {
          const original = 'value' in returnedDescriptor ? returnedDescriptor.value : returnedConfig.retries
          const cached = materialize(original)
          observedConfig = original === cached && 'value' in returnedDescriptor ? returnedConfig : { retries: cached }
        }
        onHandoff(observedConfig, message.event, {
          originalFor: value => originals.get(value) || normalizeIdentity(value),
          snapshotFor: value => snapshots.get(normalizeIdentity(value)) ?? value,
          getterKeys: value => getters.get(normalizeIdentity(value)) || new Set(),
        })
      } finally {
        stop()
      }
    }
    return originalSend.apply(this, forwardedArguments)
  }
  process.send = send
  return stop
}
