'use strict'

const session = require('../session')

const LEAF_SUBTYPES = new Set(['date', 'regexp'])
const ITERABLE_SUBTYPES = new Set(['map', 'set', 'weakmap', 'weakset'])

module.exports = {
  getRuntimeObject: getObject
}

// TODO: Can we speed up thread pause time by calling mutiple Runtime.getProperties in parallel when possible?
// The most simple solution would be to swich from an async/await approach to a callback based approach, in which case
// each lookup will just finish in its own time and traverse the child nodes when the event loop allows it.
// Alternatively, use `Promise.all` or something like that, but the code would probably be more complex.

async function getObject (objectId, maxDepth, depth = 0) {
  const { result, privateProperties } = await session.post('Runtime.getProperties', {
    objectId,
    ownProperties: true // exclude inherited properties
  })

  if (privateProperties) result.push(...privateProperties)

  return traverseGetPropertiesResult(result, maxDepth, depth)
}

async function traverseGetPropertiesResult (props, maxDepth, depth) {
  // TODO: Decide if we should filter out non-enumerable properties or not:
  // props = props.filter((e) => e.enumerable)

  if (depth >= maxDepth) return props

  for (const prop of props) {
    if (prop.value === undefined) continue
    const { value: { type, objectId, subtype } } = prop
    if (type === 'object') {
      if (objectId === undefined) continue // if `subtype` is "null"
      if (LEAF_SUBTYPES.has(subtype)) continue // don't waste time with these subtypes
      prop.value.properties = await getObjectProperties(subtype, objectId, maxDepth, depth)
    } else if (type === 'function') {
      prop.value.properties = await getFunctionProperties(objectId, maxDepth, depth + 1)
    }
  }

  return props
}

async function getObjectProperties (subtype, objectId, maxDepth, depth) {
  if (ITERABLE_SUBTYPES.has(subtype)) {
    return getIterable(objectId, maxDepth, depth)
  } else if (subtype === 'promise') {
    return getInternalProperties(objectId, maxDepth, depth)
  } else if (subtype === 'proxy') {
    return getProxy(objectId, maxDepth, depth)
  } else if (subtype === 'arraybuffer') {
    return getArrayBuffer(objectId, maxDepth, depth)
  } else {
    return getObject(objectId, maxDepth, depth + 1)
  }
}

// TODO: The following extra information from `internalProperties` might be relevant to include for functions:
// - Bound function: `[[TargetFunction]]`, `[[BoundThis]]` and `[[BoundArgs]]`
// - Non-bound function: `[[FunctionLocation]]`, and `[[Scopes]]`
async function getFunctionProperties (objectId, maxDepth, depth) {
  let { result } = await session.post('Runtime.getProperties', {
    objectId,
    ownProperties: true // exclude inherited properties
  })

  // For legacy reasons (I assume) functions has a `prototype` property besides the internal `[[Prototype]]`
  result = result.filter(({ name }) => name !== 'prototype')

  return traverseGetPropertiesResult(result, maxDepth, depth)
}

async function getIterable (objectId, maxDepth, depth) {
  const { internalProperties } = await session.post('Runtime.getProperties', {
    objectId,
    ownProperties: true // exclude inherited properties
  })

  let entry = internalProperties[1]
  if (entry.name !== '[[Entries]]') {
    // Currently `[[Entries]]` is the last of 2 elements, but in case this ever changes, fall back to searching
    entry = internalProperties.findLast(({ name }) => name === '[[Entries]]')
  }

  // Skip the `[[Entries]]` level and go directly to the content of the iterable
  const { result } = await session.post('Runtime.getProperties', {
    objectId: entry.value.objectId,
    ownProperties: true // exclude inherited properties
  })

  return traverseGetPropertiesResult(result, maxDepth, depth)
}

async function getInternalProperties (objectId, maxDepth, depth) {
  const { internalProperties } = await session.post('Runtime.getProperties', {
    objectId,
    ownProperties: true // exclude inherited properties
  })

  // We want all internal properties except the prototype
  const props = internalProperties.filter(({ name }) => name !== '[[Prototype]]')

  return traverseGetPropertiesResult(props, maxDepth, depth)
}

async function getProxy (objectId, maxDepth, depth) {
  const { internalProperties } = await session.post('Runtime.getProperties', {
    objectId,
    ownProperties: true // exclude inherited properties
  })

  // TODO: If we do not skip the proxy wrapper, we can add a `revoked` boolean
  let entry = internalProperties[1]
  if (entry.name !== '[[Target]]') {
    // Currently `[[Target]]` is the last of 2 elements, but in case this ever changes, fall back to searching
    entry = internalProperties.findLast(({ name }) => name === '[[Target]]')
  }

  // Skip the `[[Target]]` level and go directly to the target of the Proxy
  const { result } = await session.post('Runtime.getProperties', {
    objectId: entry.value.objectId,
    ownProperties: true // exclude inherited properties
  })

  return traverseGetPropertiesResult(result, maxDepth, depth)
}

// Support for ArrayBuffer is a bit trickly because the internal structure stored in `internalProperties` is not
// documented and is not straight forward. E.g. ArrayBuffer(3) will internally contain both Int8Array(3) and
// UInt8Array(3), whereas ArrayBuffer(8) internally contains both Int8Array(8), Uint8Array(8), Int16Array(4), and
// Int32Array(2) - all representing the same data in different ways.
async function getArrayBuffer (objectId, maxDepth, depth) {
  const { internalProperties } = await session.post('Runtime.getProperties', {
    objectId,
    ownProperties: true // exclude inherited properties
  })

  // Use Uint8 to make it easy to convert to a string later.
  const entry = internalProperties.find(({ name }) => name === '[[Uint8Array]]')

  // Skip the `[[Uint8Array]]` level and go directly to the content of the ArrayBuffer
  const { result } = await session.post('Runtime.getProperties', {
    objectId: entry.value.objectId,
    ownProperties: true // exclude inherited properties
  })

  return traverseGetPropertiesResult(result, maxDepth, depth)
}
