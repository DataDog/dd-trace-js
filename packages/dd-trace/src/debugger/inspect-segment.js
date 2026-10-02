'use strict'

const { inspect, types } = require('node:util')

const { NODE_MAJOR } = require('../../../../version')
const { REDACTED_PLACEHOLDER } = require('./redaction')

/** @typedef {NonNullable<ReturnType<typeof globalThis.Object.getOwnPropertyDescriptor>>} PropertyDescriptor */
/** @typedef {Map<unknown, unknown> | Set<unknown>} Collection */
/** @typedef {(name: string) => boolean} IsRedactedIdentifier */

const mapEntries = Map.prototype.entries
const mapKeys = Map.prototype.keys
const mapSet = Map.prototype.set
const mapSizeGetter = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get
const setAdd = Set.prototype.add
const setSizeGetter = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get
const setValues = Set.prototype.values
const mapIteratorNext = Object.getPrototypeOf(mapEntries.call(new Map())).next
const setIteratorNext = Object.getPrototypeOf(setValues.call(new Set())).next

const maxCollectionEntries = 3
const maxProperties = 5
const segmentInspectOptions = {
  depth: 0,
  customInspect: false,
  maxArrayLength: maxCollectionEntries,
  maxStringLength: 8 * 1024,
  breakLength: Infinity,
}
const redactedDescriptor = { value: REDACTED_PLACEHOLDER, enumerable: true }

module.exports = createInspectSegment

/**
 * @param {IsRedactedIdentifier} isRedactedIdentifier - Whether the value of a property or Map entry with the given key
 *   must be redacted.
 */
function createInspectSegment (isRedactedIdentifier) {
  return (/** @type {unknown} */ value) => inspectSegment(value, isRedactedIdentifier)
}

/**
 * Inspect a dynamic-instrumentation template value without invoking user code.
 * Unlike collections, `util.inspect` has no option for limiting the number of object properties, so this function
 * truncates objects before inspecting them. It also replaces the values of redacted properties and Map entries, the
 * same way they are redacted from snapshots.
 *
 * @param {unknown} value
 * @param {IsRedactedIdentifier} isRedactedIdentifier
 */
function inspectSegment (value, isRedactedIdentifier) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return inspect(value, segmentInspectOptions)
  }
  if (types.isProxy(value)) return '[Proxy]'
  if (types.isMap(value)) return inspectCollection(value, true, isRedactedIdentifier)
  if (types.isSet(value)) return inspectCollection(value, false, isRedactedIdentifier)
  if (
    Array.isArray(value) ||
    types.isTypedArray(value) ||
    types.isAnyArrayBuffer(value) ||
    types.isDataView(value) ||
    types.isWeakMap(value) ||
    types.isWeakSet(value) ||
    types.isMapIterator(value) ||
    types.isSetIterator(value)
  ) {
    return inspect(value, segmentInspectOptions)
  }

  /** @type {(string | symbol)[]} */
  const keys = Object.keys(value)
  let propertyCount = keys.length
  const symbols = Object.getOwnPropertySymbols(value)
  for (let i = 0; i < symbols.length; i++) {
    if (Object.getOwnPropertyDescriptor(value, symbols[i])?.enumerable === true) {
      propertyCount++
      if (keys.length < maxProperties) keys.push(symbols[i])
    }
  }

  if (propertyCount <= maxProperties) {
    // TODO: Decide whether allowing util.inspect to invoke Symbol.toStringTag getters is acceptable. If it is,
    // remove inspectionCanRunUserCode and the related omission paths.
    if (inspectionCanRunUserCode(value)) {
      return '[Value omitted: inspection may execute user code]'
    }
    if (!hasRedactedKey(keys, isRedactedIdentifier)) return inspect(value, segmentInspectOptions)

    // Inspect a copy with the redacted values replaced. It keeps the prototype, so the constructor name is still shown.
    const redacted = Object.create(Object.getPrototypeOf(value))
    for (let i = 0; i < keys.length; i++) {
      if (isRedactedKey(keys[i], isRedactedIdentifier)) {
        Object.defineProperty(redacted, keys[i], redactedDescriptor)
      } else {
        const descriptor = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(value, keys[i]))
        if (descriptor.value === value) descriptor.value = redacted
        Object.defineProperty(redacted, keys[i], descriptor)
      }
    }
    return inspect(redacted, segmentInspectOptions)
  }

  const truncated = {}
  for (let i = 0; i < maxProperties; i++) {
    if (isRedactedKey(keys[i], isRedactedIdentifier)) {
      Object.defineProperty(truncated, keys[i], redactedDescriptor)
      continue
    }
    const descriptor = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(value, keys[i]))
    if (
      (keys[i] === Symbol.toStringTag && descriptor.get !== undefined) ||
      (descriptor.value !== value && inspectionCanRunUserCode(descriptor.value))
    ) {
      return '[Value omitted: inspection may execute user code]'
    }
    if (descriptor.value === value) descriptor.value = truncated
    Object.defineProperty(truncated, keys[i], descriptor)
  }

  const omitted = propertyCount - maxProperties
  const inspected = inspect(truncated, segmentInspectOptions)
  return `${inspected.slice(0, -2)}, ... ${omitted} more ${omitted === 1 ? 'property' : 'properties'} }`
}

/**
 * Inspect a Map or Set while bounding the number of entries on Node.js 18, where `util.inspect` does not, and replacing
 * the values of redacted Map entries.
 *
 * @param {Collection} value
 * @param {boolean} isMap
 * @param {IsRedactedIdentifier} isRedactedIdentifier
 */
function inspectCollection (value, isMap, isRedactedIdentifier) {
  const size = (isMap ? mapSizeGetter : setSizeGetter).call(value)
  const truncate = NODE_MAJOR === 18 && size > maxCollectionEntries
  if (!truncate && !(isMap && mapHasRedactedKey(/** @type {Map<unknown, unknown>} */ (value), isRedactedIdentifier))) {
    return inspect(value, segmentInspectOptions)
  }

  // Only the entries that are rendered are copied
  const copy = isMap ? new Map() : new Set()
  const iterator = (isMap ? mapEntries : setValues).call(value)
  const iteratorNext = isMap ? mapIteratorNext : setIteratorNext

  for (let i = 0; i < maxCollectionEntries; i++) {
    const result = iteratorNext.call(iterator)
    if (result.done) break

    if (isMap) {
      const entry = result.value
      const key = entry[0] === value ? copy : entry[0]
      let entryValue = entry[1] === value ? copy : entry[1]
      if (isRedactedKey(entry[0], isRedactedIdentifier)) entryValue = REDACTED_PLACEHOLDER
      mapSet.call(copy, key, entryValue)
    } else {
      const entryValue = result.value === value ? copy : result.value
      setAdd.call(copy, entryValue)
    }
  }

  const inspected = inspect(copy, segmentInspectOptions)
  if (size <= maxCollectionEntries) return inspected

  const type = isMap ? 'Map' : 'Set'
  const normalized = inspected.replace(`${type}(${maxCollectionEntries})`, `${type}(${size})`)
  const remaining = size - maxCollectionEntries
  return `${normalized.slice(0, -2)}, ... ${remaining} more item${remaining === 1 ? '' : 's'} }`
}

/**
 * Determine whether any of the Map entries rendered by `util.inspect` has a redacted key.
 *
 * @param {Map<unknown, unknown>} map
 * @param {IsRedactedIdentifier} isRedactedIdentifier
 */
function mapHasRedactedKey (map, isRedactedIdentifier) {
  const iterator = mapKeys.call(map)
  for (let i = 0; i < maxCollectionEntries; i++) {
    const result = mapIteratorNext.call(iterator)
    if (result.done) return false
    if (isRedactedKey(result.value, isRedactedIdentifier)) return true
  }
  return false
}

/**
 * @param {(string | symbol)[]} keys
 * @param {IsRedactedIdentifier} isRedactedIdentifier
 */
function hasRedactedKey (keys, isRedactedIdentifier) {
  for (let i = 0; i < keys.length; i++) {
    if (isRedactedKey(keys[i], isRedactedIdentifier)) return true
  }
  return false
}

/**
 * Determine whether a property or Map key is redacted. Like in snapshots, only string and symbol keys can be redacted.
 *
 * @param {unknown} key
 * @param {IsRedactedIdentifier} isRedactedIdentifier
 */
function isRedactedKey (key, isRedactedIdentifier) {
  if (typeof key === 'string') return isRedactedIdentifier(key)
  if (typeof key === 'symbol') return isRedactedIdentifier(key.description ?? '')
  return false
}

/**
 * Determine whether inspecting a value could invoke a proxy trap or toStringTag getter.
 *
 * @param {unknown} value
 */
function inspectionCanRunUserCode (value) {
  const type = typeof value
  if (value === null || (type !== 'object' && type !== 'function')) return false
  if (types.isProxy(value)) return true

  let current = value
  while (current !== null) {
    if (Object.getOwnPropertyDescriptor(current, Symbol.toStringTag)?.get !== undefined) return true
    current = Object.getPrototypeOf(current)
    if (types.isProxy(current)) return true
  }
  return false
}
