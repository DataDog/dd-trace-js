'use strict'

const { collectionSizeSym, fieldCountSym } = require('./symbols')
const { normalizeName, REDACTED_IDENTIFIERS } = require('./redaction')

module.exports = {
  processRawState: processProperties
}

// Matches classes in source code, no matter how it's written:
// - Named:                          class MyClass {}
// - Anonymous:                      class {}
// - Named, with odd whitespace:     class\n\t MyClass\n{}
// - Anonymous, with odd whitespace: class\n{}
const CLASS_REGEX = /^class\s([^{]*)/

function processProperties (props, maxLength) {
  const result = {}

  for (const prop of props) {
    // TODO: Hack to avoid periods in keys, as EVP doesn't support that. A better solution can be implemented later
    let name = prop.name
    if (name.includes('.')) {
      name = name.replaceAll('.', '_')
    }
    result[name] = getPropertyValue(prop, maxLength)
  }

  return result
}

// TODO: Improve performance of redaction algorithm.
// This algorithm is probably slower than if we embedded the redaction logic inside the functions below.
// That way we didn't have to traverse objects that will just be redacted anyway.
function getPropertyValue (prop, maxLength) {
  return redact(prop, getPropertyValueRaw(prop, maxLength))
}

function getPropertyValueRaw (prop, maxLength) {
  // Special case for getters and setters which does not have a value property
  if (Object.hasOwn(prop, 'get')) {
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
      return getObjectValue(prop.value, maxLength)
    case 'string':
      return toString(prop.value.value, maxLength)
    case 'number':
      return { type: 'number', value: prop.value.description } // use `description` to get it as string
    case 'boolean':
      return { type: 'boolean', value: prop.value.value === true ? 'true' : 'false' }
    case 'function':
      return toFunctionOrClass(prop.value, maxLength)
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
      return { type: prop.value.type, notCapturedReason: 'Unsupported property type' }
  }
}

function getObjectValue (obj, maxLength) {
  switch (obj.subtype) {
    case undefined:
      return toObject(obj.className, obj.properties, maxLength)
    case 'array':
      return toArray(obj.className, obj.properties, maxLength)
    case 'null':
      return { type: 'null', isNull: true }
    // case 'node': // TODO: What does this subtype represent?
    case 'regexp':
      return { type: obj.className, value: obj.description }
    case 'date':
      // TODO: This looses millisecond resolution, as that's not retained in the `.toString()` representation contained
      // in the `description` field. Unfortunately that's all we get from the Chrome DevTools Protocol.
      return { type: obj.className, value: `${new Date(obj.description).toISOString().slice(0, -5)}Z` }
    case 'map':
      return toMap(obj.className, obj.properties, maxLength)
    case 'set':
      return toSet(obj.className, obj.properties, maxLength)
    case 'error':
      // TODO: Convert stack trace to array to avoid string truncation or disable truncation in this case?
      return toObject(obj.className, obj.properties, maxLength)
    case 'proxy':
      // Use `description` instead of `className` as the `type` to get type of target object (`Proxy(Error)` vs `proxy`)
      return toObject(obj.description, obj.properties, maxLength)
    case 'promise':
      return toObject(obj.className, obj.properties, maxLength)
    case 'typedarray':
      return toArray(obj.className, obj.properties, maxLength)
    case 'generator':
      // Use `subtype` instead of `className` to make it obvious it's a generator
      return toObject(obj.subtype, obj.properties, maxLength)
    case 'arraybuffer':
      return toArrayBuffer(obj.className, obj.properties, maxLength)
    case 'weakmap':
      return toMap(obj.className, obj.properties, maxLength)
    case 'weakset':
      return toSet(obj.className, obj.properties, maxLength)
    // case 'iterator': // TODO: I've not been able to trigger this subtype
    // case 'dataview': // TODO: Looks like the internal ArrayBuffer is only accessible via the `buffer` getter
    // case 'webassemblymemory': // TODO: Looks like the internal ArrayBuffer is only accessible via the `buffer` getter
    // case 'wasmvalue': // TODO: I've not been able to trigger this subtype
    default:
      // As of this writing, the Chrome DevTools Protocol doesn't allow any other subtypes than the ones listed above,
      // but in the future new ones might be added.
      return { type: obj.subtype, notCapturedReason: 'Unsupported object type' }
  }
}

function toFunctionOrClass (value, maxLength) {
  const classMatch = value.description.match(CLASS_REGEX)

  if (classMatch === null) {
    // This is a function
    // TODO: Would it make sense to detect if it's an arrow function or not?
    return toObject(value.className, value.properties, maxLength)
  }
  // This is a class
  const className = classMatch[1].trim()
  return { type: className ? `class ${className}` : 'class' }
}

function toString (str, maxLength) {
  const size = str.length

  if (size <= maxLength) {
    return { type: 'string', value: str }
  }

  return {
    type: 'string',
    value: str.slice(0, maxLength),
    truncated: true,
    size
  }
}

function toObject (type, props, maxLength) {
  if (props === undefined) return notCapturedDepth(type)

  const result = {
    type,
    fields: processProperties(props, maxLength)
  }

  if (Object.hasOwn(props, fieldCountSym)) {
    result.notCapturedReason = 'fieldCount'
    result.size = props[fieldCountSym]
  }

  return result
}

function toArray (type, elements, maxLength) {
  if (elements === undefined) return notCapturedDepth(type)

  const result = {
    type,
    elements: elements.map((element) => {
      return getPropertyValue(element, maxLength)
    })
  }

  setNotCaptureReasonOnCollection(result, elements)

  return result
}

function toMap (type, pairs, maxLength) {
  if (pairs === undefined) return notCapturedDepth(type)

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
      const shouldRedact = shouldRedactMapValue(value.properties[0])
      const key = getPropertyValue(value.properties[0], maxLength)
      const val = shouldRedact
        ? notCapturedRedacted(value.properties[1].value.type)
        : getPropertyValue(value.properties[1], maxLength)
      return [key, val]
    })
  }

  setNotCaptureReasonOnCollection(result, pairs)

  return result
}

function toSet (type, values, maxLength) {
  if (values === undefined) return notCapturedDepth(type)

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
      return getPropertyValue(value.properties[0], maxLength)
    })
  }

  setNotCaptureReasonOnCollection(result, values)

  return result
}

function toArrayBuffer (type, bytes, maxLength) {
  if (bytes === undefined) return notCapturedDepth(type)

  const size = bytes.length

  return size > maxLength
    ? {
        type,
        value: arrayBufferToString(bytes, maxLength),
        truncated: true,
        size: bytes.length
      }
    : { type, value: arrayBufferToString(bytes, size) }
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
  return normalizeName(prop.name, Object.hasOwn(prop, 'symbol'))
}

function setNotCaptureReasonOnCollection (result, collection) {
  if (Object.hasOwn(collection, collectionSizeSym)) {
    result.notCapturedReason = 'collectionSize'
    result.size = collection[collectionSizeSym]
  }
}

function notCapturedDepth (type) {
  return { type, notCapturedReason: 'depth' }
}

function notCapturedRedacted (type) {
  return { type, notCapturedReason: 'redactedIdent' }
}
