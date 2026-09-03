'use strict'

const { INCOMPLETE_REASON } = require('../../guardrail-metrics')
const { LARGE_OBJECT_SKIP_THRESHOLD } = require('./constants')
const { collectionSizeSym, largeCollectionSkipThresholdSym, fieldCountSym, timeBudgetSym } = require('./symbols')
const { normalizeName, REDACTED_IDENTIFIERS } = require('./redaction')

module.exports = {
  processRawState: processProperties,
  processRemoteObject,
}

/**
 * A RemoteObject with collected properties attached.
 *
 * @typedef {import('inspector').Runtime.RemoteObject & { properties?: object[] }} RemoteObjectWithProperties
 */

/**
 * Accumulates which capture limits were enforced while processing a single event, so they can be reported once per
 * event instead of once per affected node.
 *
 * @typedef {object} IncompleteCapture
 * @property {number} reasons - Bitmask of {@link INCOMPLETE_REASON} flags
 */

/**
 * Process a RemoteObject into the snapshot format.
 *
 * @param {RemoteObjectWithProperties} remoteObject
 * @param {number} maxLength - Maximum string length
 * @param {IncompleteCapture} incomplete - Receives the capture limits enforced on the object
 * @returns {object} The processed value in snapshot format
 */
function processRemoteObject (remoteObject, maxLength, incomplete) {
  return getPropertyValueRaw({ value: remoteObject }, maxLength, incomplete)
}

// Matches classes in source code, no matter how it's written:
// - Named:                          class MyClass {}
// - Anonymous:                      class {}
// - Named, with odd whitespace:     class\n\t MyClass\n{}
// - Anonymous, with odd whitespace: class\n{}
const CLASS_REGEX = /^class\s([^{]*)/

/**
 * Process the collected properties of an object into the snapshot format.
 *
 * @param {object[]} props - The collected property descriptors
 * @param {number} maxLength - Maximum string length
 * @param {IncompleteCapture} incomplete - Receives the capture limits enforced on the properties
 * @returns {Record<string, object>} The processed properties in snapshot format
 */
function processProperties (props, maxLength, incomplete) {
  const result = {}

  for (const prop of props) {
    // TODO: Hack to avoid periods in keys, as EVP doesn't support that. A better solution can be implemented later
    let name = prop.name
    if (name.includes('.')) {
      name = name.replaceAll('.', '_')
    }
    result[name] = getPropertyValue(prop, maxLength, incomplete)
  }

  return result
}

// TODO: Improve performance of redaction algorithm.
// This algorithm is probably slower than if we embedded the redaction logic inside the functions below.
// That way we didn't have to traverse objects that will just be redacted anyway.
function getPropertyValue (prop, maxLength, incomplete) {
  return redact(prop, getPropertyValueRaw(prop, maxLength, incomplete))
}

function getPropertyValueRaw (prop, maxLength, incomplete) {
  // Special case for getters and setters which does not have a value property
  if (prop.get) {
    const hasGet = prop.get.type !== 'undefined'
    const hasSet = prop.set.type !== 'undefined'
    if (hasGet) {
      if (hasSet) return { type: 'getter/setter' }
      return { type: 'getter' }
    }
    if (hasSet) return { type: 'setter' }
  }

  switch (prop.value?.type) {
    case 'object':
      return getObjectValue(prop.value, maxLength, incomplete)
    case 'string':
      return toString(prop.value.value, maxLength, incomplete)
    case 'number':
      return { type: 'number', value: prop.value.description } // use `description` to get it as string
    case 'boolean':
      return { type: 'boolean', value: prop.value.value === true ? 'true' : 'false' }
    case 'function':
      return toFunctionOrClass(prop.value, maxLength, incomplete)
    case undefined: // TODO: Add test for when a prop has no value. I think it's if it's defined after the breakpoint?
    case 'undefined':
      return { type: 'undefined' }
    case 'symbol':
      return { type: 'symbol', value: prop.value.description }
    case 'bigint':
      return { type: 'bigint', value: prop.value.description.slice(0, -1) } // remove trailing `n`
    default:
      // As of this writing, the Chrome DevTools Protocol doesn't allow any other types than the ones listed above, but
      // in the future new ones might be added.
      incomplete.reasons |= INCOMPLETE_REASON.OTHER
      return { type: prop.value.type, notCapturedReason: 'Unsupported property type' }
  }
}

function getObjectValue (obj, maxLength, incomplete) {
  const timeBudgetReached = obj[timeBudgetSym] === true

  switch (obj.subtype) {
    case undefined:
      return toObject(obj.className, obj.properties, maxLength, timeBudgetReached, incomplete)
    case 'array':
      return toArray(obj.className, obj.properties, maxLength, timeBudgetReached, incomplete)
    case 'null':
      return { type: 'null', isNull: true }
    // case 'node': // TODO: What does this subtype represent?
    case 'regexp':
      return { type: obj.className, value: obj.description }
    case 'date': {
      // TODO: This looses millisecond resolution, as that's not retained in the `.toString()` representation contained
      // in the `description` field. Unfortunately that's all we get from the Chrome DevTools Protocol.
      const date = new Date(obj.description)
      const value = Number.isNaN(date.getTime()) ? obj.description : `${date.toISOString().slice(0, -5)}Z`
      return { type: obj.className, value }
    }
    case 'map':
      return toMap(obj.className, obj.properties, maxLength, timeBudgetReached, incomplete)
    case 'set':
      return toSet(obj.className, obj.properties, maxLength, timeBudgetReached, incomplete)
    case 'error':
      // TODO: Convert stack trace to array to avoid string truncation or disable truncation in this case?
      return toObject(obj.className, obj.properties, maxLength, timeBudgetReached, incomplete)
    case 'proxy':
      // Use `description` instead of `className` as the `type` to get type of target object (`Proxy(Error)` vs `proxy`)
      return toObject(obj.description, obj.properties, maxLength, timeBudgetReached, incomplete)
    case 'promise':
      return toObject(obj.className, obj.properties, maxLength, timeBudgetReached, incomplete)
    case 'typedarray':
      return toArray(obj.className, obj.properties, maxLength, timeBudgetReached, incomplete)
    case 'generator':
      // Use `subtype` instead of `className` to make it obvious it's a generator
      return toObject(obj.subtype, obj.properties, maxLength, timeBudgetReached, incomplete)
    case 'arraybuffer':
      return toArrayBuffer(obj.className, obj.properties, maxLength, timeBudgetReached, incomplete)
    case 'weakmap':
      return toMap(obj.className, obj.properties, maxLength, timeBudgetReached, incomplete)
    case 'weakset':
      return toSet(obj.className, obj.properties, maxLength, timeBudgetReached, incomplete)
    // case 'iterator': // TODO: I've not been able to trigger this subtype
    // case 'dataview': // TODO: Looks like the internal ArrayBuffer is only accessible via the `buffer` getter
    // case 'webassemblymemory': // TODO: Looks like the internal ArrayBuffer is only accessible via the `buffer` getter
    // case 'wasmvalue': // TODO: I've not been able to trigger this subtype
    default:
      // As of this writing, the Chrome DevTools Protocol doesn't allow any other subtypes than the ones listed above,
      // but in the future new ones might be added.
      incomplete.reasons |= INCOMPLETE_REASON.OTHER
      return { type: obj.subtype, notCapturedReason: 'Unsupported object type' }
  }
}

function toFunctionOrClass (value, maxLength, incomplete) {
  const classMatch = value.description.match(CLASS_REGEX)

  if (classMatch === null) {
    // This is a function
    const timeBudgetReached = value[timeBudgetSym] === true
    // TODO: Would it make sense to detect if it's an arrow function or not?
    return toObject(value.className, value.properties, maxLength, timeBudgetReached, incomplete)
  }
  // This is a class
  const className = classMatch[1].trim()
  return { type: className ? `class ${className}` : 'class' }
}

function toString (str, maxLength, incomplete) {
  const size = str.length

  if (size <= maxLength) {
    return { type: 'string', value: str }
  }

  incomplete.reasons |= INCOMPLETE_REASON.STRING_LENGTH

  return {
    type: 'string',
    value: str.slice(0, maxLength),
    truncated: true,
    size,
  }
}

function toObject (type, props, maxLength, timeBudgetReached, incomplete) {
  if (timeBudgetReached === true) return notCapturedTimeBudget(type, incomplete)
  if (props === undefined) return notCapturedDepth(type, incomplete)

  const result = {
    type,
    fields: processProperties(props, maxLength, incomplete),
  }

  if (props[fieldCountSym] !== undefined) {
    incomplete.reasons |= INCOMPLETE_REASON.FIELD_COUNT
    result.notCapturedReason = 'fieldCount'
    result.size = props[fieldCountSym]
  }

  return result
}

function toArray (type, elements, maxLength, timeBudgetReached, incomplete) {
  if (timeBudgetReached === true) return notCapturedTimeBudget(type, incomplete)
  if (elements === undefined) return notCapturedDepth(type, incomplete)

  const result = {
    type,
    elements: elements.map((element) => {
      return getPropertyValue(element, maxLength, incomplete)
    }),
  }

  setNotCaptureReasonOnCollection(result, elements, incomplete)
  setNotCaptureReasonOnTooLargeCollection(result, elements, incomplete)

  return result
}

function toMap (type, pairs, maxLength, timeBudgetReached, incomplete) {
  if (timeBudgetReached === true) return notCapturedTimeBudget(type, incomplete)
  if (pairs === undefined) return notCapturedDepth(type, incomplete)
  if (pairs.length > 0 && pairs.every(({ value }) => value[timeBudgetSym] === true)) {
    return notCapturedTimeBudget(type, incomplete)
  }

  const result = {
    type,
    entries: pairs.map(({ value }) => {
      // The following code is based on assumptions made when researching the
      // output of the Chrome DevTools Protocol. There doesn't seem to be any
      // documentation to back it up:
      //
      // `pair.value` is a special wrapper-object with subtype `internal#entry`.
      // This can be skipped and we can go directly to its children, of which
      // there will always be exactly two, the first containing the key, and the
      // second containing the value of this entry of the Map.

      if (value[timeBudgetSym] === true) {
        incomplete.reasons |= INCOMPLETE_REASON.TIMEOUT
        return [{ notCapturedReason: 'timeout' }, { notCapturedReason: 'timeout' }]
      }
      if (value.properties === undefined) {
        incomplete.reasons |= INCOMPLETE_REASON.OTHER
        return [{ notCapturedReason: 'unknown' }, { notCapturedReason: 'unknown' }]
      }

      const shouldRedact = shouldRedactMapValue(value.properties[0])
      const key = getPropertyValue(value.properties[0], maxLength, incomplete)
      const val = shouldRedact
        ? notCapturedRedacted(value.properties[1].value.type)
        : getPropertyValue(value.properties[1], maxLength, incomplete)
      return [key, val]
    }),
  }

  setNotCaptureReasonOnCollection(result, pairs, incomplete)
  setNotCaptureReasonOnTooLargeCollection(result, pairs, incomplete)

  return result
}

function toSet (type, values, maxLength, timeBudgetReached, incomplete) {
  if (timeBudgetReached === true) return notCapturedTimeBudget(type, incomplete)
  if (values === undefined) return notCapturedDepth(type, incomplete)
  if (values.length > 0 && values.every(({ value }) => value[timeBudgetSym] === true)) {
    return notCapturedTimeBudget(type, incomplete)
  }

  const result = {
    type,
    elements: values.map(({ value }) => {
      // The following code is based on assumptions made when researching the
      // output of the Chrome DevTools Protocol. There doesn't seem to be any
      // documentation to back it up:
      //
      // `value.value` is a special wrapper-object with subtype
      // `internal#entry`. This can be skipped and we can go directly to its
      // children, of which there will always be exactly one, which contain the
      // actual value in this entry of the Set.

      if (value[timeBudgetSym] === true) {
        incomplete.reasons |= INCOMPLETE_REASON.TIMEOUT
        return { notCapturedReason: 'timeout' }
      }
      if (value.properties === undefined) {
        incomplete.reasons |= INCOMPLETE_REASON.OTHER
        return { notCapturedReason: 'unknown' }
      }

      return getPropertyValue(value.properties[0], maxLength, incomplete)
    }),
  }

  setNotCaptureReasonOnCollection(result, values, incomplete)
  setNotCaptureReasonOnTooLargeCollection(result, values, incomplete)

  return result
}

function toArrayBuffer (type, bytes, maxLength, timeBudgetReached, incomplete) {
  if (timeBudgetReached === true) return notCapturedTimeBudget(type, incomplete)
  if (bytes === undefined) return notCapturedDepth(type, incomplete)

  const size = bytes.length

  if (size > maxLength) {
    incomplete.reasons |= INCOMPLETE_REASON.STRING_LENGTH
    return {
      type,
      value: arrayBufferToString(bytes, maxLength),
      truncated: true,
      size: bytes.length,
    }
  }

  return { type, value: arrayBufferToString(bytes, size) }
}

function arrayBufferToString (bytes, size) {
  const buf = Buffer.allocUnsafe(size)
  for (let i = 0; i < size; i++) {
    buf[i] = bytes[i].value.value
  }
  return buf.toString()
}

function redact (prop, obj) {
  const name = getNormalizedNameFromProp(prop)
  return REDACTED_IDENTIFIERS.has(name) ? notCapturedRedacted(obj.type) : obj
}

function shouldRedactMapValue (key) {
  const isSymbol = key.value.type === 'symbol'
  if (!isSymbol && key.value.type !== 'string') return false // WeakMaps uses objects as keys
  const name = normalizeName(
    isSymbol ? key.value.description : key.value.value,
    isSymbol
  )
  return REDACTED_IDENTIFIERS.has(name)
}

function getNormalizedNameFromProp (prop) {
  return normalizeName(prop.name, prop.symbol !== undefined)
}

function setNotCaptureReasonOnCollection (result, collection, incomplete) {
  if (collection[collectionSizeSym] !== undefined) {
    incomplete.reasons |= INCOMPLETE_REASON.COLLECTION_SIZE
    result.notCapturedReason = 'collectionSize'
    result.size = collection[collectionSizeSym]
  }
}

function setNotCaptureReasonOnTooLargeCollection (result, collection, incomplete) {
  if (collection[largeCollectionSkipThresholdSym] !== undefined) {
    // The collection was skipped entirely because it exceeded the skip threshold, which is a different limit than the
    // `maxCollectionSize` limit that `collectionSize` represents
    incomplete.reasons |= INCOMPLETE_REASON.OTHER
    result.notCapturedReason = `Large collection with too many elements (skip threshold: ${
      LARGE_OBJECT_SKIP_THRESHOLD
    })`
    result.size = collection[largeCollectionSkipThresholdSym]
  }
}

function notCapturedDepth (type, incomplete) {
  incomplete.reasons |= INCOMPLETE_REASON.DEPTH
  return { type, notCapturedReason: 'depth' }
}

function notCapturedRedacted (type) {
  return { type, notCapturedReason: 'redactedIdent' }
}

function notCapturedTimeBudget (type, incomplete) {
  incomplete.reasons |= INCOMPLETE_REASON.TIMEOUT
  return { type, notCapturedReason: 'timeout' }
}
