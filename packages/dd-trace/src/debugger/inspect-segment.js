'use strict'

const { inspect, types } = require('node:util')

/** @typedef {NonNullable<ReturnType<typeof globalThis.Object.getOwnPropertyDescriptor>>} PropertyDescriptor */

const maxProperties = 5
const segmentInspectOptions = {
  depth: 0,
  customInspect: false,
  maxArrayLength: 3,
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
  if (
    Array.isArray(value) ||
    types.isTypedArray(value) ||
    types.isAnyArrayBuffer(value) ||
    types.isDataView(value) ||
    types.isMap(value) ||
    types.isSet(value) ||
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
