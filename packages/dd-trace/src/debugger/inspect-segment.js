'use strict'

const { inspect, types } = require('node:util')

const { NODE_MAJOR } = require('../../../../version')

/** @typedef {NonNullable<ReturnType<typeof globalThis.Object.getOwnPropertyDescriptor>>} PropertyDescriptor */
/** @typedef {Map<unknown, unknown> | Set<unknown>} Collection */

const mapEntries = Map.prototype.entries
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

module.exports = inspectSegment

/**
 * Inspect a dynamic-instrumentation template value without invoking user code.
 * Unlike collections, `util.inspect` has no option for limiting the number of object properties, so this function
 * truncates objects before inspecting them.
 *
 * @param {unknown} value
 * @returns {string}
 */
function inspectSegment (value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return inspect(value, segmentInspectOptions)
  }
  if (types.isProxy(value)) return '[Proxy]'
  if (types.isMap(value)) return inspectCollection(value, true)
  if (types.isSet(value)) return inspectCollection(value, false)
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
    return inspect(value, segmentInspectOptions)
  }

  const truncated = {}
  for (let i = 0; i < maxProperties; i++) {
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
 * Inspect a Map or Set while bounding the number of entries on Node.js 18, where `util.inspect` does not.
 *
 * @param {Collection} value
 * @param {boolean} isMap
 * @returns {string}
 */
function inspectCollection (value, isMap) {
  if (NODE_MAJOR !== 18) return inspect(value, segmentInspectOptions)

  const size = (isMap ? mapSizeGetter : setSizeGetter).call(value)
  if (size <= maxCollectionEntries) return inspect(value, segmentInspectOptions)

  const truncated = isMap ? new Map() : new Set()
  const iterator = (isMap ? mapEntries : setValues).call(value)
  const iteratorNext = isMap ? mapIteratorNext : setIteratorNext

  for (let i = 0; i < maxCollectionEntries; i++) {
    const result = iteratorNext.call(iterator)
    if (result.done) break

    if (isMap) {
      const entry = result.value
      const key = entry[0] === value ? truncated : entry[0]
      const entryValue = entry[1] === value ? truncated : entry[1]
      mapSet.call(truncated, key, entryValue)
    } else {
      const entryValue = result.value === value ? truncated : result.value
      setAdd.call(truncated, entryValue)
    }
  }

  const type = isMap ? 'Map' : 'Set'
  const inspected = inspect(truncated, segmentInspectOptions)
  const normalized = inspected.replace(`${type}(${maxCollectionEntries})`, `${type}(${size})`)
  const remaining = size - maxCollectionEntries
  return `${normalized.slice(0, -2)}, ... ${remaining} more item${remaining === 1 ? '' : 's'} }`
}

/**
 * Determine whether inspecting a value could invoke a proxy trap or toStringTag getter.
 *
 * @param {unknown} value
 * @returns {boolean}
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
