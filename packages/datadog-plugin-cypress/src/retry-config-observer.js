'use strict'

const observeSetupHandoff = require('./setup-handoff')

/** @param {object} value Retry values observed at a Cypress IPC boundary. */
function snapshot (value) {
  // Match Cypress's JSON wire values, independently of descriptor flags.
  // eslint-disable-next-line unicorn/prefer-structured-clone
  return JSON.parse(JSON.stringify(value))
}

/**
 * Observe user writes after plugin initialization without changing the config's identity.
 *
 * @param {object} config
 * @param {Function} onChange
 * @param {{ nativeRetries: unknown, updateNative: Function, reconcileNative?: Function }} [options]
 */
module.exports = function observeRetryConfig (config, onChange, options) {
  const descriptor = Object.getOwnPropertyDescriptor(config, 'retries')
  if (!descriptor?.writable || !('value' in descriptor)) return

  const initial = config.retries
  let active = true
  const roots = new WeakMap()
  const targets = new WeakMap()
  // Cypress keeps nested retry settings in first-level options objects.
  const children = new WeakMap()
  const unwrap = value => targets.get(value) || value
  const rememberChild = (metadata, key, value) => {
    const raw = unwrap(value)
    if (!options || !raw || typeof raw !== 'object' || children.has(raw)) return
    children.set(raw, { raw, native: metadata.native?.[key], observed: snapshot(raw) })
  }
  const refreshChild = (key, child) => {
    if (!active || !options?.reconcileNative) return
    child.native = options.reconcileNative(
      { [key]: child.native }, { [key]: child.observed }, { [key]: child.raw }
    )[key]
    child.observed = snapshot(child.raw)
  }
  const refreshNative = metadata => {
    if (active && metadata && options?.reconcileNative) {
      const actual = { ...metadata.raw }
      for (const key of Object.keys(actual)) {
        const child = children.get(unwrap(actual[key]))
        if (child) {
          refreshChild(key, child)
          actual[key] = child.native
        }
      }
      metadata.native = options.reconcileNative(metadata.native, metadata.observed, actual)
      metadata.observed = snapshot(actual)
      for (const key of Object.keys(metadata.raw)) rememberChild(metadata, key, metadata.raw[key])
    }
  }
  const refreshTarget = (metadata, path, target) => {
    if (active && path.length === 1) {
      const child = children.get(unwrap(target))
      if (child) refreshChild(path[0], child)
    }
    refreshNative(metadata)
  }
  const notify = (value, path, metadata) => {
    refreshNative(metadata)
    const provenance = options && {
      retries: metadata ? metadata.native : options.updateNative(undefined, value, []),
    }
    onChange(value, path, provenance)
  }
  const initialMetadata = initial && typeof initial === 'object'
    ? {
        raw: initial,
        native: options?.nativeRetries,
        proxies: new WeakMap(),
        observed: options?.reconcileNative ? snapshot(initial) : undefined,
      }
    : undefined
  if (initialMetadata) {
    roots.set(initial, initialMetadata)
    for (const key of Object.keys(initial)) rememberChild(initialMetadata, key, initial[key])
  }
  const record = (metadata, path, target) => {
    if (!active) return
    if (options) {
      const [key] = path
      const child = path.length === 2 && children.get(unwrap(target))
      if (child) {
        refreshChild(key, child)
        child.native = options.updateNative(
          { [key]: child.native }, { [key]: child.raw }, path
        )[key]
        child.observed = snapshot(child.raw)
        // A saved options object can change while a different object is selected.
        if (unwrap(metadata.raw[key]) !== child.raw) return
        metadata.native = { ...metadata.native, [key]: child.native }
      } else {
        const restored = path.length === 1 && children.get(unwrap(metadata.raw[key]))
        if (restored) refreshChild(key, restored)
        const supplied = restored ? { ...metadata.raw, [key]: restored.native } : metadata.raw
        metadata.native = options.updateNative(metadata.native, supplied, path)
      }
    }
    // A detached alias updates only its own provenance until that root is selected again.
    if (metadata.raw === unwrap(config.retries)) notify(metadata.raw, path, metadata)
    else refreshNative(metadata)
  }
  /**
   * @param {object} target
   * @param {string|symbol} key
   * @param {unknown} value
   */
  const isSameObjectValue = (target, key, value) => {
    const raw = unwrap(value)
    const previous = Object.getOwnPropertyDescriptor(target, key)
    return raw !== null && typeof raw === 'object' && previous &&
      'value' in previous && raw === unwrap(previous.value)
  }
  const wrap = (value, metadata, path = []) => {
    value = unwrap(value)
    if (value === null || typeof value !== 'object') return value
    if (path.length === 1 && options && !children.has(value)) {
      refreshNative(metadata)
      rememberChild(metadata, path[0], value)
    }
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
        const sameObject = isSameObjectValue(target, key, value)
        const result = Reflect.set(target, key, unwrap(value))
        if (result) {
          if (sameObject) refreshTarget(metadata, path, target)
          else record(metadata, [...path, key], target)
        }
        return result
      },
      deleteProperty (target, key) {
        const result = Reflect.deleteProperty(target, key)
        if (result) record(metadata, [...path, key], target)
        return result
      },
      defineProperty (target, key, property) {
        const hasValue = 'value' in property
        const sameObject = hasValue && isSameObjectValue(target, key, property.value)
        const result = Reflect.defineProperty(target, key, property)
        if (result) {
          if (hasValue && !sameObject) record(metadata, [...path, key], target)
          else refreshTarget(metadata, path, target)
        }
        return result
      },
    })
    metadata.proxies.set(value, proxy)
    targets.set(proxy, value)
    return proxy
  }
  // Keep the native data descriptor: freeze/seal must retain JavaScript's own
  // strict/sloppy write semantics. Fresh root replacements are reconciled by
  // identity at the setup handoff; only injected objects need nested proxies.
  config.retries = wrap(initial, initialMetadata)

  // Cypress serializes the actual setupNodeEvents return value through this reply.
  // Observing it before serialization also handles a fresh partial return when the
  // manual plugin was loaded inside an already-running setup callback.
  const stop = (reconcileCurrent = true) => {
    if (active && reconcileCurrent) {
      const retries = unwrap(config.retries)
      notify(retries, [], retries && typeof retries === 'object' && roots.get(retries))
    }
    active = false
    stopIpc?.()
    const currentDescriptor = Object.getOwnPropertyDescriptor(config, 'retries')
    if (currentDescriptor?.writable && targets.has(currentDescriptor.value)) {
      config.retries = unwrap(currentDescriptor.value)
    }
  }
  const stopIpc = observeSetupHandoff((returnedConfig, event) => {
    try {
      if (active && event === 'setupTestingType:reply') {
        const retries = unwrap(returnedConfig?.retries)
        notify(retries, [], retries && typeof retries === 'object' && roots.get(retries))
      }
    } finally {
      // Later child-local writes cannot change the parent's serialized config.
      stop(false)
    }
  })

  return {
    isWatching: candidate => active && candidate === config,
    stopIpc,
    stop,
  }
}
