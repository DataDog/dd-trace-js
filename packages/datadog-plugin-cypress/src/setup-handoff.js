'use strict'

// Observe the actual setup serialization boundary without retaining ownership of process.send.
module.exports = function observeSetupHandoff (onHandoff, normalizeIdentity = value => value, captureIdentity) {
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
        const states = new WeakMap()
        const materialize = value => {
          if (!value || typeof value !== 'object') return value
          const identity = normalizeIdentity(value)
          if (snapshots.has(identity)) return snapshots.get(identity)
          const paths = new WeakMap()
          const records = []
          const occurrences = new WeakMap()
          let holder
          // JSON owns the traversal: earlier getters and toJSON methods can change
          // later retry values. Observe the same values that will cross IPC once.
          const serialized = JSON.stringify(value, function (key, current) {
            if (!holder) holder = this
            const path = this === holder ? [] : [...paths.get(this), key]
            const property = Object.getOwnPropertyDescriptor(this, key)
            if (property && !('value' in property)) occurrences.get(this)?.keys.add(key)
            if (current && typeof current === 'object') {
              const keys = new Set()
              const names = Array.isArray(current) ? Object.getOwnPropertyNames(current) : Object.keys(current)
              for (const name of names) {
                const descriptor = Object.getOwnPropertyDescriptor(current, name)
                if (descriptor && !('value' in descriptor)) keys.add(name)
              }
              const original = normalizeIdentity(current)
              const record = { path, original, keys, state: captureIdentity?.(original) }
              paths.set(current, path)
              occurrences.set(current, record)
              records.push(record)
            }
            return current
          })
          const cached = serialized === undefined ? undefined : JSON.parse(serialized)
          for (const { path, original, keys, state } of records) {
            let snapshot = cached
            for (const key of path) snapshot = snapshot[key]
            snapshots.set(original, snapshot)
            if (snapshot && typeof snapshot === 'object') {
              originals.set(snapshot, original)
              snapshots.set(snapshot, snapshot)
              getters.set(snapshot, keys)
              states.set(snapshot, state)
            }
          }
          return cached
        }
        if (wireConfig && typeof wireConfig === 'object') {
          const cached = materialize(wireConfig)
          if (cached !== wireConfig) {
            const metadataKey = Symbol.for('dd-trace.cypress.returned-config')
            const metadata = Object.getOwnPropertyDescriptor(wireConfig, metadataKey)
            if (metadata && cached && typeof cached === 'object') {
              Object.defineProperty(cached, metadataKey, metadata)
            }
            wireConfig = cached
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
          const wireRetry = wireConfig && typeof wireConfig === 'object' &&
            Object.getOwnPropertyDescriptor(wireConfig, 'retries')
          const wireValue = wireRetry && 'value' in wireRetry ? wireRetry.value : undefined
          const wireOriginal = originals.get(wireValue) || normalizeIdentity(wireValue)
          const cached = wireRetry?.enumerable && normalizeIdentity(original) === wireOriginal
            ? wireValue
            : materialize(original)
          observedConfig = original === cached && 'value' in returnedDescriptor ? returnedConfig : { retries: cached }
        }
        onHandoff(observedConfig, message.event, {
          originalFor: value => originals.get(value) || normalizeIdentity(value),
          snapshotFor: value => snapshots.get(normalizeIdentity(value)) ?? value,
          stateFor: value => states.get(normalizeIdentity(value)),
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
