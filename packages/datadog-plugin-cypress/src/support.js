'use strict'

// No optional chaining or nullish coalescing in this file: Cypress 12 bundles it with webpack 4,
// whose parser predates both, and its babel-loader skips node_modules.

const annotationsKey = Symbol.for('dd-trace:test-annotations')
const emptyAnnotations = { mustFail: false, noAutoRetry: false }
let frameworkRetries = 0
let hasSuiteConfig = false
let isTextTerminal = false
let hasBrowserRetries = false
let browserRetries
const initialBrowserRetries = Cypress._.cloneDeep(Cypress.config('retries'))
let originalRetries
let configuredRetries
let browserRetrySelection
let browserRetryAccessor
const browserRetryObjects = new WeakMap()
// Saved options keep their provenance when moved to a different retry root.
const browserRetryChildren = new WeakMap()
const browserRetryTargets = new WeakMap()
const browserConfigStates = new WeakMap()
const unwrapBrowserRetries = value => browserRetryTargets.get(value) || value
const cypressConfig = Cypress.config

// Getter values are mutable native objects. Track the written path, rather than
// mistaking untouched injected fields for developer configuration.
function overlayBrowserRetries (native, configured, actual) {
  if (Cypress._.isEqual(configured, actual)) return Cypress._.cloneDeep(native)
  if (!actual || typeof actual !== 'object' || !configured || typeof configured !== 'object') {
    return Cypress._.cloneDeep(actual)
  }
  if (typeof native === 'number') native = { runMode: native, openMode: native }
  const result = native && typeof native === 'object' ? Cypress._.cloneDeep(native) : {}
  for (const key of Object.keys(actual)) {
    if (!Cypress._.isEqual(configured[key], actual[key])) {
      result[key] = overlayBrowserRetries(result[key], configured[key], actual[key])
    }
  }
  for (const key of Object.keys(configured)) {
    // Cypress 6 predates Object.hasOwn.
    // eslint-disable-next-line prefer-object-has-own
    if (!Object.prototype.hasOwnProperty.call(actual, key)) delete result[key]
  }
  return result
}

// Cypress retry objects contain first-level experimental options with primitive fields.
function rememberBrowserRetryChild (metadata, key, value, explicit) {
  const raw = unwrapBrowserRetries(value)
  if (!raw || typeof raw !== 'object') return
  if (browserRetryChildren.has(raw)) {
    const child = browserRetryChildren.get(raw)
    metadata.children.set(raw, child)
    return child
  }
  const child = {
    owner: metadata,
    raw,
    key,
    initial: Cypress._.cloneDeep(raw),
    configured: Cypress._.cloneDeep(metadata.observed && metadata.observed[key]),
    observed: Cypress._.cloneDeep(raw),
    native: explicit ? Cypress._.cloneDeep(raw) : undefined,
    nativeReady: Boolean(explicit),
    writes: [],
  }
  metadata.children.set(raw, child)
  browserRetryChildren.set(raw, child)
  if (hasSuiteConfig) initializeBrowserRetryChild(child)
  else metadata.pendingChildren.push(child)
  return child
}

function initializeBrowserRetryChild (child) {
  // A deferred child is initialized from its original root, not the root that later selects it.
  const owner = child.owner
  if (!owner.nativeReady && hasSuiteConfig) initializeBrowserRetryMetadata(owner)
  if (!owner.nativeReady) return
  if (!child.nativeReady) {
    child.native = overlayBrowserRetries(owner.native && owner.native[child.key], child.configured, child.initial)
    child.nativeReady = true
  }
  const writes = child.writes.splice(0)
  if (writes.length) child.observed = Cypress._.cloneDeep(child.initial)
  for (const write of writes) {
    if (write.raw) {
      child.native = overlayBrowserRetries(child.native, write.observed, write.raw)
      child.observed = Cypress._.cloneDeep(write.raw)
    } else {
      child.native = updateBrowserRetryPath(child.native, [write.key], write.value, write.deleted)
      child.observed = updateBrowserRetryPath(child.observed, [write.key], write.value, write.deleted)
    }
  }
}

function refreshBrowserRetryChild (metadata, child) {
  if (hasSuiteConfig) {
    initializeBrowserRetryMetadata(metadata)
    initializeBrowserRetryChild(child)
    child.native = overlayBrowserRetries(child.native, child.observed, child.raw)
  } else if (!Cypress._.isEqual(child.observed, child.raw)) {
    child.writes.push({ observed: Cypress._.cloneDeep(child.observed), raw: Cypress._.cloneDeep(child.raw) })
  }
  child.observed = Cypress._.cloneDeep(child.raw)
}

function recordBrowserRetryChild (metadata, child, key, value, deleted) {
  if (hasSuiteConfig) {
    initializeBrowserRetryMetadata(metadata)
    initializeBrowserRetryChild(child)
    child.native = updateBrowserRetryPath(child.native, [key], value, deleted)
  } else child.writes.push({ key, value: Cypress._.cloneDeep(value), deleted })
  child.observed = updateBrowserRetryPath(child.observed, [key], value, deleted)
}

function captureBrowserRetryChild (metadata, key, value) {
  const child = rememberBrowserRetryChild(metadata, key, value, true)
  if (child) refreshBrowserRetryChild(metadata, child)
  return child
}

function initializeBrowserRetryMetadata (metadata) {
  if (!hasSuiteConfig) return
  if (!metadata.nativeReady) {
    metadata.native = overlayBrowserRetries(originalRetries, configuredRetries, metadata.initial)
    metadata.nativeReady = true
  }
  const writes = metadata.writes.splice(0)
  for (const child of metadata.pendingChildren.splice(0)) initializeBrowserRetryChild(child)
  if (writes.length) metadata.observed = Cypress._.cloneDeep(metadata.initial)
  for (const write of writes) {
    if (write.raw) {
      metadata.native = overlayBrowserRetries(metadata.native, write.observed, write.raw)
      metadata.observed = Cypress._.cloneDeep(write.raw)
      selectBrowserRetryMetadata(metadata)
    } else recordBrowserRetryPath(metadata, write.path, write.value, write.deleted, write.child)
  }
}

/**
 * @param {object|number|undefined} retries
 * @param {Array<string|symbol>} path
 * @param {unknown} value
 * @param {boolean} deleted
 */
function updateBrowserRetryPath (retries, path, value, deleted) {
  if (typeof retries === 'number') retries = { runMode: retries, openMode: retries }
  if (!retries || typeof retries !== 'object') retries = {}
  let current = retries
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]
    if (!current[key] || typeof current[key] !== 'object') current[key] = {}
    current = current[key]
  }
  // Cypress 6 uses an older browser without Array.prototype.at.
  // eslint-disable-next-line unicorn/prefer-at
  const key = path[path.length - 1]
  if (deleted) delete current[key]
  else current[key] = Cypress._.cloneDeep(value)
  return retries
}

function recordBrowserRetryPath (metadata, path, value, deleted, child) {
  // Track only the known write: unrelated raw aliases can change other paths before selection.
  if (!hasSuiteConfig) {
    metadata.observed = updateBrowserRetryPath(metadata.observed, path, value, deleted)
    metadata.writes.push({ path, value: Cypress._.cloneDeep(value), deleted, child })
    return
  }
  initializeBrowserRetryMetadata(metadata)
  metadata.observed = updateBrowserRetryPath(metadata.observed, path, value, deleted)
  if (child) refreshBrowserRetryChild(metadata, child)
  metadata.native = updateBrowserRetryPath(metadata.native, path, child ? child.native : value, deleted)
  selectBrowserRetryMetadata(metadata)
}

/** @param {object} metadata */
function selectBrowserRetryMetadata (metadata) {
  if (metadata.raw === unwrapBrowserRetries(cypressConfig.call(Cypress, 'retries'))) {
    browserRetries = metadata.native
    browserRetrySelection = metadata
    hasBrowserRetries = true
  }
}

/** @param {object} metadata */
function reconcileBrowserRetryMetadata (metadata) {
  initializeBrowserRetryMetadata(metadata)
  for (const key of Object.keys(metadata.raw)) {
    const property = Object.getOwnPropertyDescriptor(metadata.raw, key)
    const child = property && 'value' in property && metadata.children.get(unwrapBrowserRetries(property.value))
    if (!child) continue
    refreshBrowserRetryChild(metadata, child)
    if (hasSuiteConfig) metadata.native = updateBrowserRetryPath(metadata.native, [key], child.native, false)
    metadata.observed[key] = Cypress._.cloneDeep(child.raw)
  }
  if (!hasSuiteConfig) {
    if (!Cypress._.isEqual(metadata.observed, metadata.raw)) {
      const raw = Cypress._.cloneDeep(metadata.raw)
      metadata.writes.push({ raw, observed: Cypress._.cloneDeep(metadata.observed) })
      metadata.observed = Cypress._.cloneDeep(raw)
    }
    return
  }
  const changed = !Cypress._.isEqual(metadata.observed, metadata.raw)
  metadata.native = overlayBrowserRetries(metadata.native, metadata.observed, metadata.raw)
  metadata.observed = Cypress._.cloneDeep(metadata.raw)
  if (changed) selectBrowserRetryMetadata(metadata)
  if (browserRetrySelection === metadata) browserRetries = metadata.native
}

function ownsNestedPath (root, path, target) {
  let current = root
  for (const key of path) {
    if (!current || typeof current !== 'object') return false
    current = unwrapBrowserRetries(current[key])
  }
  return current === target
}

/**
 * @param {object} target
 * @param {string|symbol} key
 * @param {unknown} value
 */
function isSameBrowserObjectValue (target, key, value) {
  const raw = unwrapBrowserRetries(value)
  const previous = Object.getOwnPropertyDescriptor(target, key)
  return raw !== null && typeof raw === 'object' && previous &&
    'value' in previous && raw === unwrapBrowserRetries(previous.value)
}

function observeBrowserRetries (raw) {
  raw = unwrapBrowserRetries(raw)
  if (!raw || typeof raw !== 'object') return raw
  if (browserRetryObjects.has(raw)) return browserRetryObjects.get(raw).proxy
  const test = Cypress.state('test')
  const applied = test && test._testConfig && test._testConfig.applied
  // Native config cloning also uses this getter while applying/restoring overrides.
  // Explicit root writes already carry native intent and take priority over declarations.
  const overrides = (!hasBrowserRetries || browserRetries !== raw) &&
    (applied === 'complete' || Cypress.state('duringUserTestExecution')) && getNativeRetryOverrides(test)
  const metadata = {
    raw,
    initial: Cypress._.cloneDeep(raw),
    observed: Cypress._.cloneDeep(raw),
    reconcileOnRead: false,
    native: Cypress._.cloneDeep(overrides ? overrides.retries : hasBrowserRetries ? browserRetries : originalRetries),
    nativeReady: Boolean(overrides) || hasSuiteConfig || hasBrowserRetries,
    writes: [],
    children: new WeakMap(),
    pendingChildren: [],
  }
  for (const key of Object.keys(raw)) {
    const property = Object.getOwnPropertyDescriptor(raw, key)
    if (property && 'value' in property) rememberBrowserRetryChild(metadata, key, property.value, false)
  }
  const proxies = new WeakMap()
  function wrap (value, path) {
    value = unwrapBrowserRetries(value)
    if (!value || typeof value !== 'object') return value
    if (proxies.has(value)) return proxies.get(value)
    const child = path.length === 1 && rememberBrowserRetryChild(metadata, path[0], value, false)
    const proxy = new Proxy(value, {
      getOwnPropertyDescriptor (target, key) {
        const property = Reflect.getOwnPropertyDescriptor(target, key)
        if (property && 'value' in property && property.value && typeof property.value === 'object' &&
          ownsNestedPath(metadata.raw, path, target)) metadata.reconcileOnRead = true
        return property
      },
      get (target, key, receiver) {
        const result = Reflect.get(target, key, receiver)
        const property = Object.getOwnPropertyDescriptor(target, key)
        if (property && !property.configurable && !property.writable && 'value' in property) {
          if (result && typeof result === 'object' && ownsNestedPath(metadata.raw, path, target)) {
            metadata.reconcileOnRead = true
          }
          return result
        }
        return wrap(result, [...path, key])
      },
      set (target, key, value) {
        const sameObject = isSameBrowserObjectValue(target, key, value)
        const previous = !path.length && Object.getOwnPropertyDescriptor(target, key)
        const previousChild = previous && 'value' in previous &&
          metadata.children.get(unwrapBrowserRetries(previous.value))
        if (previousChild) refreshBrowserRetryChild(metadata, previousChild)
        const result = Reflect.set(target, key, unwrapBrowserRetries(value))
        if (result && child) {
          if (sameObject) refreshBrowserRetryChild(metadata, child)
          else recordBrowserRetryChild(metadata, child, key, value, false)
        }
        if (result && ownsNestedPath(metadata.raw, path, target)) {
          if (sameObject) {
            metadata.reconcileOnRead = true
            reconcileBrowserRetryMetadata(metadata)
          } else {
            const restored = !path.length && captureBrowserRetryChild(metadata, key, value)
            recordBrowserRetryPath(metadata, [...path, key], value, false, restored)
          }
        }
        return result
      },
      defineProperty (target, key, descriptor) {
        const hasValue = 'value' in descriptor
        const sameObject = hasValue && isSameBrowserObjectValue(target, key, descriptor.value)
        const previous = !path.length && hasValue && Object.getOwnPropertyDescriptor(target, key)
        const previousChild = previous && 'value' in previous &&
          metadata.children.get(unwrapBrowserRetries(previous.value))
        if (previousChild) refreshBrowserRetryChild(metadata, previousChild)
        const result = Reflect.defineProperty(target, key, descriptor)
        if (result && child) {
          if (hasValue && !sameObject) recordBrowserRetryChild(metadata, child, key, descriptor.value, false)
          else refreshBrowserRetryChild(metadata, child)
        }
        if (result && ownsNestedPath(metadata.raw, path, target)) {
          if (hasValue && !sameObject) {
            const restored = !path.length && captureBrowserRetryChild(metadata, key, descriptor.value)
            recordBrowserRetryPath(metadata, [...path, key], descriptor.value, false, restored)
          } else {
            metadata.reconcileOnRead = true
            reconcileBrowserRetryMetadata(metadata)
          }
        }
        return result
      },
      deleteProperty (target, key) {
        const result = Reflect.deleteProperty(target, key)
        if (result && child) recordBrowserRetryChild(metadata, child, key, undefined, true)
        if (result && ownsNestedPath(metadata.raw, path, target)) {
          recordBrowserRetryPath(metadata, [...path, key], undefined, true)
        }
        return result
      },
    })
    proxies.set(value, proxy)
    browserRetryTargets.set(proxy, value)
    return proxy
  }
  metadata.proxy = wrap(raw, [])
  browserRetryObjects.set(raw, metadata)
  browserRetryObjects.set(metadata.proxy, metadata)
  return metadata.proxy
}

// New root values are explicit native configuration. Reusing the same observed
// object preserves its field provenance, including through Cypress restoration.
function recordBrowserRetryReplacement (retries, previous) {
  retries = unwrapBrowserRetries(retries)
  const test = Cypress.state('test')
  const applied = test && test._testConfig && test._testConfig.applied
  if (applied === 'restoring') {
    const metadata = retries && typeof retries === 'object' && browserRetryObjects.get(retries)
    if (metadata) reconcileBrowserRetryMetadata(metadata)
    browserRetries = metadata ? metadata.native : overlayBrowserRetries(originalRetries, configuredRetries, retries)
    browserRetrySelection = metadata || undefined
    hasBrowserRetries = true
  } else if (!applied || applied === 'complete' || Cypress.state('duringUserTestExecution')) {
    if (retries && typeof retries === 'object' && retries === unwrapBrowserRetries(previous)) return
    const metadata = retries && typeof retries === 'object' && browserRetryObjects.get(retries)
    if (metadata) reconcileBrowserRetryMetadata(metadata)
    browserRetrySelection = metadata || undefined
    browserRetries = metadata ? metadata.native : retries
    hasBrowserRetries = true
  }
}

/** @param {object|number|undefined} value */
function observeLockedBrowserRetries (value) {
  observeBrowserRetries(value)
  const metadata = value && typeof value === 'object' && browserRetryObjects.get(unwrapBrowserRetries(value))
  if (metadata) metadata.reconcileOnRead = true
}

// An accessor's value is native intent, but defining or inspecting it must not run its getter.
function getBrowserRetryAccessor () {
  if (!browserRetryAccessor) return
  const property = Object.getOwnPropertyDescriptor(browserRetryAccessor.state, 'retries')
  if (property && !('value' in property) && property.get === browserRetryAccessor.get &&
    property.set === browserRetryAccessor.set) return property
  browserRetryAccessor = undefined
}

function recordBrowserRetryAccessorRead (value) {
  if (!getBrowserRetryAccessor()) return
  const raw = unwrapBrowserRetries(value)
  const metadata = raw && typeof raw === 'object' && browserRetryObjects.get(raw)
  browserRetrySelection = metadata || undefined
  browserRetries = metadata ? metadata.native : raw
  hasBrowserRetries = true
}

function observeBrowserConfig (state) {
  if (browserConfigStates.has(state)) return browserConfigStates.get(state)
  const proxy = new Proxy(state, {
    getOwnPropertyDescriptor (target, key) {
      const property = Reflect.getOwnPropertyDescriptor(target, key)
      if (key === 'retries' && property && 'value' in property) observeLockedBrowserRetries(property.value)
      return property
    },
    get (target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      const property = Object.getOwnPropertyDescriptor(target, key)
      if (key === 'retries') recordBrowserRetryAccessorRead(value)
      if (property && !property.configurable && !property.writable && 'value' in property) {
        if (key === 'retries') observeLockedBrowserRetries(value)
        return value
      }
      return key === 'retries' ? observeBrowserRetries(value) : value
    },
    set (target, key, value) {
      const previousProperty = Object.getOwnPropertyDescriptor(target, key)
      const previous = previousProperty && previousProperty.value
      const result = Reflect.set(target, key, key === 'retries' ? unwrapBrowserRetries(value) : value)
      if (result && key === 'retries') recordBrowserRetryReplacement(value, previous)
      return result
    },
    defineProperty (target, key, descriptor) {
      const hasValue = 'value' in descriptor
      const previousProperty = key === 'retries' && hasValue && Object.getOwnPropertyDescriptor(target, key)
      const previous = previousProperty && previousProperty.value
      const result = Reflect.defineProperty(target, key, descriptor)
      if (result && key === 'retries') {
        if (hasValue) recordBrowserRetryReplacement(descriptor.value, previous)
        const property = Object.getOwnPropertyDescriptor(target, key)
        browserRetryAccessor = property && !('value' in property)
          ? { state: target, get: property.get, set: property.set }
          : undefined
        if (property && !property.configurable && !property.writable && 'value' in property) {
          observeLockedBrowserRetries(property.value)
        }
      }
      return result
    },
    deleteProperty (target, key) {
      const previousProperty = Object.getOwnPropertyDescriptor(target, key)
      const previous = previousProperty && previousProperty.value
      const result = Reflect.deleteProperty(target, key)
      if (result && key === 'retries') recordBrowserRetryReplacement(undefined, previous)
      return result
    },
  })
  browserConfigStates.set(state, proxy)
  return proxy
}

Cypress.config = Object.assign(function (key, value) {
  const objectConfig = typeof key === 'object' && key !== null
  let objectRetries = false
  if (objectConfig) {
    // Native _.extend handles enumerable own/inherited string keys without reading symbols.
    for (const name in key) {
      if (name === 'retries') objectRetries = true
    }
  }
  const retries = !objectConfig && key === 'retries' && arguments.length > 1 ? value : undefined
  const previous = (!objectRetries && retries === undefined) || getBrowserRetryAccessor()
    ? undefined
    : cypressConfig.call(this, 'retries')
  const args = [...arguments]
  if (retries !== undefined && unwrapBrowserRetries(retries) !== retries) args[1] = unwrapBrowserRetries(retries)
  // Delegate the original object so validation and assignment retain native getter evaluation semantics.
  const result = cypressConfig.apply(this, args)
  if (objectRetries) {
    const property = Object.getOwnPropertyDescriptor(cypressConfig.call(this), 'retries')
    if (property && 'value' in property) recordBrowserRetryReplacement(property.value, previous)
  } else if (retries !== undefined) recordBrowserRetryReplacement(retries, previous)
  if (arguments.length === 0) return observeBrowserConfig(result)
  if (key === 'retries' && arguments.length === 1) recordBrowserRetryAccessorRead(result)
  return key === 'retries' && arguments.length === 1 ? observeBrowserRetries(result) : result
}, cypressConfig)

/** @param {number|object|undefined} configured */
function nativeRetryCount (configured) {
  if (typeof configured === 'number' || configured == null) return configured
  const retries = configured[isTextTerminal ? 'runMode' : 'openMode']
  return retries === true
    ? configured.experimentalOptions && configured.experimentalOptions.maxRetries
    : retries === false ? 0 : retries
}

/** @param {object} test */
function getTestAnnotations (test) {
  return test._ddTestAnnotations || (test.fn && test.fn[annotationsKey]) || emptyAnnotations
}

/** @returns {object[]} Declaration metadata, including tests whose setup never executes. */
function getTestDeclarations () {
  const testAnnotations = []
  Cypress.mocha.getRootSuite().eachTest(test => {
    const annotations = getTestAnnotations(test)
    testAnnotations.push({
      testId: test.id, testName: test.fullTitle(), mustFail: annotations.mustFail, noAutoRetry: annotations.noAutoRetry,
    })
  })
  return testAnnotations
}

let pendingSuiteDeclarationDepth = 0
const testDeclarationProxies = new WeakMap()

function captureTestDeclaration (target, receiver, args) {
  // Cypress 6 uses a browser without Array.prototype.at.
  // eslint-disable-next-line unicorn/prefer-at
  const callback = args[args.length - 1]
  const test = Reflect.apply(target, receiver, args)
  if (test && typeof callback === 'function' && callback[annotationsKey]) {
    const { mustFail, noAutoRetry } = callback[annotationsKey]
    test._ddTestAnnotations = { mustFail, noAutoRetry }
  }
  return test
}

/**
 * @param {Function} declaration
 * @param {boolean} [alwaysCapture]
 */
function wrapTestDeclaration (declaration, alwaysCapture = false) {
  if (testDeclarationProxies.has(declaration)) {
    const existing = testDeclarationProxies.get(declaration)
    if (alwaysCapture) existing.alwaysCapture = true
    return existing.proxy
  }
  const state = { alwaysCapture }
  state.proxy = new Proxy(declaration, {
    // Outside pending declarations, the intrinsic handler contributes no JavaScript
    // wrapper frame to Cypress's native callsite stack. Aliases retain this same proxy.
    get apply () {
      return state.alwaysCapture || pendingSuiteDeclarationDepth > 0 ? captureTestDeclaration : Reflect.apply
    },
    get (target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      const property = Object.getOwnPropertyDescriptor(target, key)
      if (property && !property.configurable && !property.writable && 'value' in property) return value
      return (key === 'skip' || key === 'only') && typeof value === 'function'
        ? wrapTestDeclaration(value, key === 'skip' || state.alwaysCapture)
        : value
    },
  })
  testDeclarationProxies.set(declaration, state)
  return state.proxy
}

// Observe every executable declaration identity, including aliases captured before
// entering a pending suite, while preserving native callsites during normal execution.
for (const name of ['it', 'specify', 'xit', 'xspecify']) {
  const declaration = globalThis[name]
  if (typeof declaration === 'function') {
    globalThis[name] = wrapTestDeclaration(declaration, name === 'xit' || name === 'xspecify')
  }
}

/** @param {Function} declaration */
function wrapSkippedSuiteDeclaration (declaration) {
  return function () {
    pendingSuiteDeclarationDepth++
    try {
      return declaration.apply(this, arguments)
    } finally {
      pendingSuiteDeclarationDepth--
    }
  }
}

for (const name of ['describe', 'context', 'xdescribe', 'xcontext']) {
  const declareSuite = globalThis[name]
  if (typeof declareSuite !== 'function') continue
  if (name === 'xdescribe' || name === 'xcontext') {
    globalThis[name] = wrapSkippedSuiteDeclaration(declareSuite)
  } else if (typeof declareSuite.skip === 'function') {
    declareSuite.skip = wrapSkippedSuiteDeclaration(declareSuite.skip)
  }
}

// If the test is using multi domain with cy.origin, trying to access
// window properties will result in a cross origin error.
function safeGetRum (window) {
  try {
    return window.DD_RUM
  } catch {
    return null
  }
}

/** @param {string} message */
function warnMissingBeforeEachTaskResult (message) {
  // eslint-disable-next-line no-console
  console.warn(message)
}

function disableFrameworkRetries (test) {
  test._retries = 0
}

/** @param {object} test */
function getNativeRetryOverrides (test) {
  for (let current = test; current; current = current.parent) {
    const config = current._testConfig
    const overrides = config && (config.unverifiedTestConfig || config)
    if (overrides && overrides.retries !== undefined) return overrides
  }
}

/** @param {object} test */
function getNativeRetryBudget (test) {
  const accessor = getBrowserRetryAccessor()
  const accessorValue = accessor && cypressConfig.call(Cypress, 'retries')
  if (accessor) recordBrowserRetryAccessorRead(accessorValue)
  const overrides = getNativeRetryOverrides(test)
  let metadata = browserRetrySelection
  if (!metadata) {
    const current = unwrapBrowserRetries(accessor ? accessorValue : cypressConfig.call(Cypress, 'retries'))
    const observed = current && typeof current === 'object' && browserRetryObjects.get(current)
    if (observed && observed.reconcileOnRead) metadata = observed
  }
  if (metadata) reconcileBrowserRetryMetadata(metadata)
  // A getter-only root rejects Cypress's declaration writes, so its current value remains authoritative.
  const retries = accessor && !accessor.set
    ? nativeRetryCount(browserRetries)
    : overrides
      ? nativeRetryCount(overrides.retries)
      : metadata
        ? nativeRetryCount(metadata.native)
        : hasBrowserRetries ? nativeRetryCount(browserRetries) : frameworkRetries
  return Number.isSafeInteger(retries) ? retries : 0
}

function getRetriedTests (test, numRetries, tags) {
  const retriedTests = []
  for (let retryIndex = 0; retryIndex < numRetries; retryIndex++) {
    // TODO: signal in framework logs that this is a retry.
    // TODO: Change it so these tests are allowed to fail.
    const clonedTest = test.clone()
    disableFrameworkRetries(clonedTest)
    if (tags.includes('_ddIsEfdRetry')) {
      clonedTest._ddEfdRetryIndex = retryIndex + 1
    }
    for (const tag of tags) {
      if (tag) {
        clonedTest[tag] = true
      }
    }
    retriedTests.push(clonedTest)
  }
  return retriedTests
}

// Observation must precede user support, while manual lifecycle hooks retain the
// registration point chosen by the public support entry.
let lifecycleHooksInstalled = false
function installLifecycleHooks () {
  if (lifecycleHooksInstalled) return
  lifecycleHooksInstalled = true
  let rumFlushWaitMillis = 500
  let rumTestExecutionIdCookieName

  let isEarlyFlakeDetectionEnabled = false
  let isKnownTestsEnabled = false
  let knownTestsForSuite = []
  let earlyFlakeDetectionSchedulingRetryCount = 0
  let isTestManagementEnabled = false
  let testManagementAttemptToFixRetries = 0
  let testManagementTests = {}
  let isImpactedTestsEnabled = false
  let isModifiedTest = false
  let isTestIsolationEnabled = false
  let isDynamicAtrEnabled = false
  let hasWarnedMissingBeforeEachTaskResult = false
  let hasWarnedMissingBeforeEachRetryResult = false
  // Array of test names that have been retried and the reason
  const retryReasonsByTestName = new Map()
  // Dynamic ATR computes the selected budget after the first attempt. Keep that result
  // in browser state and apply it when Cypress starts the retry runnable.
  const dynamicAtrRetryCountByTest = new Map()
  // Track test errors suppressed by test management so we can still report them to Datadog.
  const suppressedTestFailures = new Map()

  // Track the most recently loaded window in the AUT. Updated via the 'window:load'
  // event so we always get the real app window (after cy.visit()), not the
  // about:blank window that exists when beforeEach runs. If the test later navigates
  // to a cross-origin URL, safeGetRum() handles the access error.
  let originalWindow

  let currentTestCommands = []
  const commandStartTimes = new Map()
  const INTERNAL_CYPRESS_COMMANDS = new Set(['wrap', 'then', 'noop'])

  Cypress.on('command:start', (command) => {
    commandStartTimes.set(command.get('id'), { startTime: Date.now(), name: command.get('name') })
  })

  Cypress.on('command:end', (command) => {
    const id = command.get('id')
    const entry = commandStartTimes.get(id)
    commandStartTimes.delete(id)

    const name = command.get('name')
    const args = command.get('args')
    if (name === 'task' && args && typeof args[0] === 'string' && args[0].startsWith('dd:')) {
      return
    }
    if (INTERNAL_CYPRESS_COMMANDS.has(name) || entry == null) {
      return
    }
    const err = command.get('err')
    currentTestCommands.push({
      name,
      startTime: entry.startTime,
      endTime: Date.now(),
      // Serialize the error to a plain object so it survives cy.task JSON transport.
      error: err ? { message: err.message, stack: err.stack, name: err.name } : null,
    })
  })

  function isNewTest (test) {
    // If for whatever reason the worker does not receive valid known tests, we don't consider it as new
    if (!Array.isArray(knownTestsForSuite)) {
      return false
    }
    return !knownTestsForSuite.includes(test.fullTitle())
  }

  function getTestProperties (testName) {
    // TODO: Use optional chaining when we drop support for older Cypress versions, which will happen when dd-trace@5 is
    // EoL. Until then, this files needs to support Node.js 16.
    const properties = testManagementTests[testName] && testManagementTests[testName].properties || {}

    const { attempt_to_fix: isAttemptToFix, disabled: isDisabled, quarantined: isQuarantined } = properties

    return { isAttemptToFix, isDisabled, isQuarantined }
  }

  /**
   * @param {object} test
   * @returns {Cypress.Chainable<{ traceId?: string, shouldSkip?: boolean, shouldDiscard?: boolean }>}
   */
  function runBeforeEachTask (test) {
    return cy.task('dd:beforeEach', test).then((taskResult) => {
      if (taskResult !== undefined && taskResult !== null) {
        return taskResult
      }

      if (!hasWarnedMissingBeforeEachTaskResult) {
        hasWarnedMissingBeforeEachTaskResult = true
        warnMissingBeforeEachTaskResult('Datadog Cypress dd:beforeEach task returned no result. Retrying once.')
      }

      return cy.task('dd:beforeEach', test).then((retryTaskResult) => {
        if (retryTaskResult !== undefined && retryTaskResult !== null) {
          return retryTaskResult
        }

        if (!hasWarnedMissingBeforeEachRetryResult) {
          hasWarnedMissingBeforeEachRetryResult = true
          warnMissingBeforeEachTaskResult(
            'Datadog Cypress dd:beforeEach task returned no result after retry. Continuing with an empty task result.'
          )
        }

        return {}
      })
    })
  }

  /**
   * @param {string} message
   * @param {unknown} error
   * @returns {false}
   */
  function logRumCorrelationCookieError (message, error) {
    try {
      Cypress.log({
        name: 'dd-trace',
        message,
        consoleProps: () => ({ Error: error }),
      })
    } catch (loggingError) {
      // eslint-disable-next-line no-console
      console.error(message, error, loggingError)
    }
    return false
  }

  /**
   * @param {unknown} error
   * @returns {false}
   */
  function handleRumCorrelationCookieError (error) {
    return logRumCorrelationCookieError('Could not set the RUM correlation cookie', error)
  }

  /**
   * @param {unknown} error
   * @returns {false}
   */
  function handleRumCorrelationCookieCleanupError (error) {
    return logRumCorrelationCookieError('Could not clear the previous RUM correlation cookie', error)
  }

  /**
   * @param {string} traceId
   * @returns {Promise<boolean>}
   */
  function setRumCorrelationCookie (traceId) {
    if (typeof cy.now !== 'function') {
      return Cypress.Promise.resolve(handleRumCorrelationCookieError(new Error('Cypress cy.now is not available')))
    }

    let clearCookiePromise = Cypress.Promise.resolve()
    if (!isTestIsolationEnabled) {
      clearCookiePromise = Cypress.Promise.try(() => {
        return cy.now('clearCookie', rumTestExecutionIdCookieName, { log: false })
      }).then(undefined, handleRumCorrelationCookieCleanupError)
    }

    return clearCookiePromise.then(() => {
      return Cypress.Promise.try(() => {
        return cy.now('setCookie', rumTestExecutionIdCookieName, traceId, { log: false })
      })
    }).then(() => true, handleRumCorrelationCookieError)
  }

  /**
   * @param {boolean} isCookieSet
   */
  function restartRumSession (isCookieSet) {
    if (!isCookieSet || isTestIsolationEnabled || !originalWindow) {
      return
    }

    const rum = safeGetRum(originalWindow)
    if (rum) {
      try {
        const evt = new originalWindow.MouseEvent('click', { bubbles: true, cancelable: true })
        // The browser-sdk addEventListener wrapper filters out untrusted synthetic events
        // unless __ddIsTrusted is set. Set it so the click triggers expandOrRenewSession().
        // See: https://github.com/DataDog/browser-sdk/blob/v6.27.1/packages/core/src/browser/addEventListener.ts#L119
        Object.defineProperty(evt, '__ddIsTrusted', { value: true })
        originalWindow.dispatchEvent(evt)
      } catch {}
      if (rum.startView) {
        rum.startView()
      }
    }
  }

  // Catch test failures for quarantined tests and suppress them
  // By not re-throwing the error, Cypress marks the test as passed
  // This allows quarantined tests to run but not affect the exit code
  Cypress.on('fail', (err, runnable) => {
    // For commands that time out, command:end may never fire.
    // Finalize any in-flight commands so their step spans carry the error.
    const hadInFlightCommands = commandStartTimes.size > 0
    for (const [, { startTime, name }] of commandStartTimes) {
      if (INTERNAL_CYPRESS_COMMANDS.has(name)) continue
      currentTestCommands.push({
        name,
        startTime,
        endTime: Date.now(),
        error: { message: err.message, stack: err.stack, name: err.name },
      })
    }
    commandStartTimes.clear()

    // If command:end fired for all commands (none in-flight) but the last command
    // has no error, it means command:end fired before the error was attached to it.
    if (!hadInFlightCommands && currentTestCommands.length > 0) {
      // We have to support very old cypress versions in v5
      // eslint-disable-next-line unicorn/prefer-at
      const lastCommand = currentTestCommands[currentTestCommands.length - 1]
      if (!lastCommand.error) {
        lastCommand.error = { message: err.message, stack: err.stack, name: err.name }
      }
    }

    if (!isTestManagementEnabled) {
      throw err
    }

    const testName = runnable.fullTitle()
    const annotations = getTestAnnotations(runnable)
    const properties = getTestProperties(testName)
    const isAttemptToFix = properties.isAttemptToFix && !annotations.noAutoRetry
    const isQuarantined = properties.isQuarantined && !annotations.mustFail
    const isDisabled = properties.isDisabled && !annotations.mustFail

    // Suppress failures for quarantined or disabled tests so they don't affect the exit code.
    // Attempt-to-fix ignores quarantine/disabled suppression and keeps the normal framework result.
    if (!isAttemptToFix && (isQuarantined || isDisabled)) {
      suppressedTestFailures.set(testName, { error: err, isQuarantined, isDisabled })
      return
    }

    throw err
  })

  function shouldDisableFrameworkRetries (test) {
    return test && (
      test._ddIsAttemptToFix ||
      (isTestIsolationEnabled &&
        isEarlyFlakeDetectionEnabled &&
        (test._ddIsNew || test._ddIsModified))
    )
  }

  const oldRunTests = Cypress.mocha.getRunner().runTests
  Cypress.mocha.getRunner().runTests = function (suite, fn) {
    if (!isKnownTestsEnabled && !isTestManagementEnabled && !isImpactedTestsEnabled) {
      return oldRunTests.apply(this, arguments)
    }
    // We copy the tests array and add retries to it, then assign it back to suite.tests
    // to avoid modifying the array while iterating over it
    const testsWithRetries = []

    for (let testIndex = 0; testIndex < suite.tests.length; testIndex++) {
      const test = suite.tests[testIndex]
      const testName = test.fullTitle()
      const { isAttemptToFix } = getTestProperties(testName)
      const isSkipped = test.isPending()

      const annotations = getTestAnnotations(test)
      const isAtemptToFix = isTestManagementEnabled && isAttemptToFix && !isSkipped && !annotations.noAutoRetry
      const isModified = isImpactedTestsEnabled && isModifiedTest
      const isNew = isKnownTestsEnabled && !isSkipped && isNewTest(test)

      // We want is_modified and is_new regardless of the retry reason
      if (isModified) {
        test._ddIsModified = true
      }
      if (isNew) {
        test._ddIsNew = true
      }

      // Add the original test first
      testsWithRetries.push(test)

      if (!isTestIsolationEnabled || annotations.noAutoRetry) {
        continue
      }

      // Then add retries right after it
      let retriedTests = []
      let retryMessage = ''
      if (isAtemptToFix) {
        test._ddIsAttemptToFix = true
        disableFrameworkRetries(test)
        retryMessage = 'because it is an attempt to fix'
        retriedTests = getRetriedTests(test, testManagementAttemptToFixRetries, ['_ddIsAttemptToFix'])
      } else if (isModified && isEarlyFlakeDetectionEnabled) {
        disableFrameworkRetries(test)
        retryMessage = 'to detect flakes because it is modified'
        retriedTests = getRetriedTests(test, earlyFlakeDetectionSchedulingRetryCount, [
          '_ddIsModified',
          '_ddIsEfdRetry',
          isKnownTestsEnabled && isNewTest(test) && '_ddIsNew',
        ])
      } else if (isNew && isEarlyFlakeDetectionEnabled) {
        disableFrameworkRetries(test)
        retryMessage = 'to detect flakes because it is new'
        retriedTests = getRetriedTests(test, earlyFlakeDetectionSchedulingRetryCount, ['_ddIsNew', '_ddIsEfdRetry'])
      }

      testsWithRetries.push(...retriedTests)

      if (retryMessage) {
        retryReasonsByTestName.set(testName, retryMessage)
      }
    }

    suite.tests = testsWithRetries

    return oldRunTests.apply(this, [suite, fn])
  }

  /**
   * @param {{ id: string }} test
   */
  function getDynamicAtrTestKey (test) {
    // Cypress preserves the runnable ID when cloning a retry, including across browser reloads.
    return `${Cypress.mocha.getRootSuite().file}\0${test.id}`
  }

  /**
   * @param {{ id: string, _retries: number }} test
   */
  function configureTestRetries (test) {
    if (hasSuiteConfig && getTestAnnotations(test).noAutoRetry) {
      // Restore developer configuration after the plugin's global ATR configuration.
      // Read the nearest test/suite override before or after Cypress resolves it.
      test._retries = getNativeRetryBudget(test)
      // Cypress resolves local retries after this event; the support hook reapplies this value.
      return
    }
    if (shouldDisableFrameworkRetries(test)) {
      disableFrameworkRetries(test)
      return
    }

    if (!isTextTerminal) return

    const dynamicAtrRetryCount = dynamicAtrRetryCountByTest.get(getDynamicAtrTestKey(test))
    if (Number.isSafeInteger(dynamicAtrRetryCount)) {
      test._retries = dynamicAtrRetryCount
    } else if (isDynamicAtrEnabled) {
      // Cypress forbids calling retries(count) on the original runnable.
      // Ensure local retries: 0 overrides still reach the duration-based budget selection.
      test._retries = Math.max(1, test._retries)
    }
  }

  Cypress.on('test:before:run', (attributes, test) => {
    configureTestRetries(test)
  })

  Cypress.on('test:before:run:async', (attributes, test) => {
    configureTestRetries(test)
  })

  beforeEach(function () {
    const currentTest = Cypress.mocha.getRunner().suite.ctx.currentTest
    // The first test:before:run event can precede the suite configuration task.
    configureTestRetries(currentTest)
    const testName = currentTest.fullTitle()

    const retryMessage = retryReasonsByTestName.get(testName)
    if (retryMessage) {
      cy.task(
        'dd:log',
        `Retrying "${testName}" ${retryMessage}`
      )
      retryReasonsByTestName.delete(testName)
    }

    currentTestCommands = []
    commandStartTimes.clear()

    cy.on('window:load', (win) => {
      originalWindow = win
    })

    runBeforeEachTask({
      testId: currentTest.id,
      testName,
      annotations: getTestAnnotations(currentTest),
      testSuite: Cypress.mocha.getRootSuite().file,
      isEfdRetry: Cypress.mocha.getRunner().suite.ctx.currentTest._ddIsEfdRetry,
      efdRetryIndex: Cypress.mocha.getRunner().suite.ctx.currentTest._ddEfdRetryIndex,
    }).then(({ traceId, shouldSkip, shouldDiscard }) => {
      if (shouldDiscard) {
        this.currentTest._ddShouldDiscard = true
      }
      let rumCookiePromise
      if (traceId) {
        rumCookiePromise = setRumCorrelationCookie(traceId)
      }
      if (shouldSkip) {
        // Test Optimization requested this runtime skip through the Cypress support hook.
        this.skip()
      }
      if (rumCookiePromise) {
        return rumCookiePromise.then(restartRumSession)
      }
    }).then(() => {
      // Clear any commands accumulated during DD-owned setup (e.g. setCookie, RUM restart)
      // so they are not reported as user test steps.
      currentTestCommands = []
      commandStartTimes.clear()
    })
  })

  before(function () {
    cy.task('dd:testSuiteStart', {
      testAnnotations: getTestDeclarations(),
      testSuite: Cypress.mocha.getRootSuite().file,
      testSuiteAbsolutePath: Cypress.spec && Cypress.spec.absolute,
      isTextTerminal: Cypress.config('isTextTerminal'),
    }).then((suiteConfig) => {
      if (suiteConfig) {
        hasSuiteConfig = true
        frameworkRetries = suiteConfig.frameworkRetries
        originalRetries = suiteConfig.originalRetries
        configuredRetries = suiteConfig.configuredRetries
        const rawRetries = cypressConfig.call(Cypress, 'retries')
        const metadata = rawRetries && typeof rawRetries === 'object' && browserRetryObjects.get(rawRetries)
        if (metadata) initializeBrowserRetryMetadata(metadata)
        if (!hasBrowserRetries &&
            !Cypress._.isEqual(initialBrowserRetries, suiteConfig.configuredRetries)) {
          // Manual support can load after a browser configuration override already happened.
          browserRetries = overlayBrowserRetries(
            originalRetries, suiteConfig.configuredRetries, initialBrowserRetries
          )
          hasBrowserRetries = true
        }
        isEarlyFlakeDetectionEnabled = suiteConfig.isEarlyFlakeDetectionEnabled
        isKnownTestsEnabled = suiteConfig.isKnownTestsEnabled
        knownTestsForSuite = suiteConfig.knownTestsForSuite
        earlyFlakeDetectionSchedulingRetryCount = suiteConfig.earlyFlakeDetectionSchedulingRetryCount
        isTestManagementEnabled = suiteConfig.isTestManagementEnabled
        testManagementAttemptToFixRetries = suiteConfig.testManagementAttemptToFixRetries
        testManagementTests = suiteConfig.testManagementTests
        isImpactedTestsEnabled = suiteConfig.isImpactedTestsEnabled
        isModifiedTest = suiteConfig.isModifiedTest
        isTestIsolationEnabled = suiteConfig.isTestIsolationEnabled
        isDynamicAtrEnabled = suiteConfig.isDynamicAtrEnabled
        isTextTerminal = suiteConfig.isTextTerminal
        if (isTextTerminal) {
          // The first test event can precede this task, and an earlier user hook can skip our beforeEach.
          Cypress.mocha.getRootSuite().eachTest(configureTestRetries)
        }
        rumTestExecutionIdCookieName = suiteConfig.rumTestExecutionIdCookieName
        if (Number.isFinite(suiteConfig.rumFlushWaitMillis)) {
          rumFlushWaitMillis = suiteConfig.rumFlushWaitMillis
        }
      }
    })
  })

  after(() => {
    // Root teardown still runs when a user root setup hook fails before Datadog setup.
    // Publish all declarations so Node-side recovery can annotate the skipped tests.
    if (!hasSuiteConfig) {
      cy.task('dd:testDeclarations', {
        testSuite: Cypress.mocha.getRootSuite().file,
        testAnnotations: getTestDeclarations(),
      })
    }
    dynamicAtrRetryCountByTest.clear()
    try {
      if (safeGetRum(originalWindow)) {
        originalWindow.dispatchEvent(new Event('beforeunload'))
      }
    } catch {
      // ignore error. It's usually a multi origin issue.
    }
  })

  afterEach(function () {
    const currentTest = Cypress.mocha.getRunner().suite.ctx.currentTest
    if (currentTest._ddShouldDiscard) {
      return
    }
    const testName = currentTest.fullTitle()

    // Check if this was a test management test that we suppressed the failure for.
    const suppressedTestFailure = suppressedTestFailures.get(testName)
    const suppressedError = suppressedTestFailure && suppressedTestFailure.error
    const isTestManagementTestThatFailed = !!suppressedError

    // For suppressed test management tests, convert Error to a serializable format for cy.task.
    const errorToReport = isTestManagementTestThatFailed
      ? { message: suppressedError.message, stack: suppressedError.stack }
      : currentTest.err

    const activeRetries = Cypress.config('retries')
    const nativeRetryFloor = activeRetries && activeRetries.experimentalStrategy ? getNativeRetryBudget(currentTest) : 0
    const testInfo = {
      nativeRetryFloor,
      testId: currentTest.id,
      testName,
      testItTitle: currentTest.title,
      testSuite: Cypress.mocha.getRootSuite().file,
      testSuiteAbsolutePath: Cypress.spec && Cypress.spec.absolute,
      // Report the actual failed state to Datadog, not the pass state Cypress sees after suppression.
      state: isTestManagementTestThatFailed ? 'failed' : currentTest.state,
      // Include the actual error that was suppressed.
      error: errorToReport,
      isNew: currentTest._ddIsNew,
      isEfdRetry: currentTest._ddIsEfdRetry,
      isAttemptToFix: currentTest._ddIsAttemptToFix,
      annotations: getTestAnnotations(currentTest),
      isModified: currentTest._ddIsModified,
      hasNativeRetries: !!(currentTest._testConfig && currentTest._testConfig.unverifiedTestConfig &&
        currentTest._testConfig.unverifiedTestConfig.retries !== undefined),
      duration: currentTest.duration,
      // Mark suppressed tests so the plugin can tag them with the correct test management reason.
      isQuarantined: isTestManagementTestThatFailed && suppressedTestFailure.isQuarantined,
      isDisabled: isTestManagementTestThatFailed && suppressedTestFailure.isDisabled,
    }
    try {
      const invocationDetails = Cypress.mocha.getRunner().currentRunnable.invocationDetails
      testInfo.testSourceLine = invocationDetails.line
      testInfo.testSourceStack = invocationDetails.stack
    } catch {}

    // Snapshot before any DD-owned Cypress commands so they are not reported as test steps.
    const commandsToReport = [...currentTestCommands]

    const rum = safeGetRum(originalWindow)
    if (rum) {
      testInfo.isRUMActive = true
      if (rum.stopSession) {
        rum.stopSession()
        // eslint-disable-next-line cypress/no-unnecessary-waiting
        cy.wait(rumFlushWaitMillis)
      }
    }
    let coverage
    try {
      coverage = originalWindow.__coverage__
    } catch {
      // ignore error and continue
    }

    // Clean up the suppressed error tracking.
    if (isTestManagementTestThatFailed) {
      suppressedTestFailures.delete(testName)
    }

    cy.task('dd:afterEach', { test: testInfo, coverage, commands: commandsToReport }).then((taskResult) => {
      // Preserve the first-attempt result until Cypress starts the retry runnable.
      // Changing the completed test here is too late for Cypress's retry lifecycle.
      if (taskResult && Number.isSafeInteger(taskResult.dynamicAtrRetryCount)) {
        dynamicAtrRetryCountByTest.set(getDynamicAtrTestKey(currentTest), taskResult.dynamicAtrRetryCount)
      }
    })
  })
}

const supportRoot = Cypress.mocha.getRootSuite()
supportRoot[Symbol.for('dd-trace.cypress.install-lifecycle')] = installLifecycleHooks
if (!supportRoot[Symbol.for('dd-trace.cypress.defer-lifecycle')]) installLifecycleHooks()
