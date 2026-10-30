'use strict'

const observeSetupHandoff = require('./setup-handoff')

// Configuration inspection must not evaluate accessors before Cypress serializes them.
function snapshot (value, previous) {
  if (!value || typeof value !== 'object') return value
  const result = Array.isArray(value) ? [] : {}
  for (const key of Object.keys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key)
    const entry = 'value' in property ? snapshot(property.value, previous?.[key]) : previous?.[key]
    if (entry !== undefined) result[key] = entry
  }
  return result
}

function snapshotMetadata (metadata) {
  return metadata && { native: snapshot(metadata.native), observed: snapshot(metadata.observed) }
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
      { [key]: child.native }, { [key]: child.observed }, { [key]: snapshot(child.raw, child.observed) }
    )[key]
    child.observed = snapshot(child.raw, child.observed)
  }
  const refreshNative = metadata => {
    if (active && metadata && options?.reconcileNative) {
      const actual = snapshot(metadata.raw, metadata.observed)
      for (const key of Object.keys(actual)) {
        const property = Object.getOwnPropertyDescriptor(metadata.raw, key)
        const child = property && 'value' in property && children.get(unwrap(property.value))
        if (child) {
          refreshChild(key, child)
          actual[key] = child.native
        }
      }
      metadata.native = options.reconcileNative(metadata.native, metadata.observed, actual)
      metadata.observed = snapshot(actual)
      for (const key of Object.keys(metadata.raw)) {
        const property = Object.getOwnPropertyDescriptor(metadata.raw, key)
        if ('value' in property) rememberChild(metadata, key, property.value)
      }
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
    let native
    if (options) {
      native = metadata ? metadata.native : options.updateNative(undefined, snapshot(value), [])
      if (!metadata && value && typeof value === 'object') {
        // A new root can select options already observed under another root.
        for (const key of Object.keys(value)) {
          const property = Object.getOwnPropertyDescriptor(value, key)
          const child = property && 'value' in property && children.get(unwrap(property.value))
          if (child) {
            refreshChild(key, child)
            native = options.updateNative(native, { [key]: child.native }, [key])
          }
        }
      }
    }
    const provenance = options && { retries: native }
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
    for (const key of Object.keys(initial)) {
      const property = Object.getOwnPropertyDescriptor(initial, key)
      if ('value' in property) rememberChild(initialMetadata, key, property.value)
    }
  }
  const record = (metadata, path, target) => {
    if (!active) return
    if (options) {
      const [key] = path
      const child = path.length === 2 && children.get(unwrap(target))
      if (child) {
        refreshChild(key, child)
        child.native = options.updateNative(
          { [key]: child.native }, { [key]: snapshot(child.raw, child.observed) }, path
        )[key]
        child.observed = snapshot(child.raw, child.observed)
        // A saved options object can change while a different object is selected.
        if (unwrap(Object.getOwnPropertyDescriptor(metadata.raw, key)?.value) !== child.raw) return
        metadata.native = { ...metadata.native, [key]: child.native }
      } else {
        const restored = path.length === 1 && children.get(
          unwrap(Object.getOwnPropertyDescriptor(metadata.raw, key)?.value)
        )
        if (restored) refreshChild(key, restored)
        const actual = snapshot(metadata.raw, metadata.observed)
        const supplied = restored ? { ...actual, [key]: restored.native } : actual
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
  const stopIpc = observeSetupHandoff((returnedConfig, event, context) => {
    try {
      if (active && event === 'setupTestingType:reply') {
        const property = returnedConfig && Object.getOwnPropertyDescriptor(returnedConfig, 'retries')
        const retries = property?.enumerable ? returnedConfig.retries : undefined
        const original = value => context?.originalFor(value) ?? value
        const source = original(retries)
        const raw = unwrap(source)
        const cached = context?.snapshotFor(retries) ?? retries
        const captured = context?.stateFor(cached)
        const metadata = captured ? captured.root : raw && typeof raw === 'object' && roots.get(raw)
        const actual = snapshot(cached, metadata?.observed)
        let native = options && (metadata
          ? (options.reconcileNative
              ? options.reconcileNative(metadata.native, metadata.observed, actual)
              : metadata.native)
          : options.updateNative(undefined, actual, []))
        if (options && actual && typeof actual === 'object') {
          for (const key of Object.keys(actual)) {
            const sourceChild = original(cached[key])
            const rawChild = unwrap(sourceChild)
            const capturedChild = context?.stateFor(cached[key])
            const child = capturedChild
              ? capturedChild.child
              : rawChild && typeof rawChild === 'object' && children.get(rawChild)
            if (!child) continue
            let childNative = options.reconcileNative
              ? options.reconcileNative(
                { [key]: child.native }, { [key]: child.observed }, { [key]: actual[key] }
              )[key]
              : child.native
            if (context) {
              for (const getterKey of context.getterKeys(cached[key])) {
                childNative = options.updateNative(
                  { [key]: childNative }, { [key]: actual[key] }, [key, getterKey]
                )[key]
              }
            }
            native = options.updateNative(native, { [key]: childNative }, [key])
          }
          if (context) {
            for (const key of context.getterKeys(cached)) {
              native = options.updateNative(native, actual, [key])
            }
          }
        }
        onChange(retries, [], options && { retries: native })
      }
    } finally {
      // Later child-local writes cannot change the parent's serialized config.
      stop(false)
    }
  }, unwrap, value => {
    // Freeze provenance at this serialized occurrence. Later config getters can
    // mutate the same retry object after its active value has already crossed IPC.
    return { root: snapshotMetadata(roots.get(value)), child: snapshotMetadata(children.get(value)) }
  })

  return {
    isWatching: candidate => active && candidate === config,
    stopIpc,
    stop,
  }
}
