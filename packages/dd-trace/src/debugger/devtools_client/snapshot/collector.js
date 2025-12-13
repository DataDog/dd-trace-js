'use strict'

const { collectionSizeSym, largeCollectionSkipThresholdSym, fieldCountSym, timeBudgetSym } = require('./symbols')
const { LARGE_OBJECT_SKIP_THRESHOLD } = require('./constants')
const session = require('../session')

const LEAF_SUBTYPES = new Set(['date', 'regexp'])
const ITERABLE_SUBTYPES = new Set(['map', 'set', 'weakmap', 'weakset'])
const SIZE_IN_DESCRIPTION_SUBTYPES = new Set(['array', 'typedarray', 'arraybuffer', 'dataview', 'map', 'set'])

module.exports = {
  collectObjectProperties
}

/**
 * @typedef {Object} GetObjectOptions
 * @property {Object} maxReferenceDepth - The maximum depth of the object to traverse
 * @property {number} maxCollectionSize - The maximum size of a collection to include in the snapshot
 * @property {number} maxFieldCount - The maximum number of properties on an object to include in the snapshot
 * @property {bigint} deadlineNs - The deadline in nanoseconds compared to `process.hrtime.bigint()`
 * @property {Object} ctx - A context object to track the state/progress of the snapshot collection.
 * @property {boolean} ctx.deadlineReached - Will be set to `true` if the deadline has been reached.
 * @property {Error[]} ctx.captureErrors - An array on which errors can be pushed if an issue is detected while
 *   collecting the snapshot.
 */

/**
 * Collect the properties of an object using the Chrome DevTools Protocol.
 *
 * @param {string} objectId - The ID of the object to get the properties of
 * @param {GetObjectOptions} opts - The options for the snapshot. Also used to track the deadline and communicate the
 *   deadline overrun to the caller using the `deadlineReached` flag.
 * @param {number} [depth=0] - The depth of the object. Only used internally by this module to track the current depth
 *   and should not be set by the caller.
 * @param {boolean} [collection=false] - Whether the object is a collection. Only used internally by this module to
 *   track the current object type and should not be set by the caller.
 * @returns {Promise<Object[]>} The properties of the object
 */
async function collectObjectProperties (objectId, opts, depth = 0, collection = false) {
  const { result, privateProperties } = await session.post('Runtime.getProperties', {
    objectId,
    ownProperties: true // exclude inherited properties
  })

  if (collection) {
    // Trim the collection if it's too large.
    // Collections doesn't contain private properties, so the code in this block doesn't have to deal with it.
    removeNonEnumerableProperties(result) // remove the `length` property
    const size = result.length
    if (size > opts.maxCollectionSize) {
      result.length = opts.maxCollectionSize
      result[collectionSizeSym] = size
    }
  } else if (result.length > opts.maxFieldCount) {
    // Trim the number of properties on the object if there's too many.
    const size = result.length
    if (size > LARGE_OBJECT_SKIP_THRESHOLD) {
      opts.ctx.captureErrors.push(new Error(
        `An object with ${size} properties was detected while collecting a snapshot. ` +
        `This exceeds the maximum number of allowed properties of ${LARGE_OBJECT_SKIP_THRESHOLD}. ` +
        'Future snapshots for existing probes in this location will be skipped until the Node.js process is restarted'
      ))
    }
    result.length = opts.maxFieldCount
    result[fieldCountSym] = size
  } else if (privateProperties) {
    result.push(...privateProperties)
  }

  return traverseGetPropertiesResult(result, opts, depth)
}

async function traverseGetPropertiesResult (props, opts, depth) {
  // TODO: Decide if we should filter out non-enumerable properties or not:
  // props = props.filter((e) => e.enumerable)

  if (depth >= opts.maxReferenceDepth) return props

  const work = []

  for (const prop of props) {
    if (prop.value === undefined) continue
    const { value: { type, objectId, subtype, description } } = prop
    if (type === 'object') {
      if (objectId === undefined) continue // if `subtype` is "null"
      if (LEAF_SUBTYPES.has(subtype)) continue // don't waste time with these subtypes
      const size = parseLengthFromDescription(description, subtype)
      if (size !== null && size >= LARGE_OBJECT_SKIP_THRESHOLD) {
        const empty = []
        empty[largeCollectionSkipThresholdSym] = size
        prop.value.properties = empty
        continue
      }
      work.push([
        prop.value,
        () => collectPropertiesBySubtype(subtype, objectId, opts, depth).then((properties) => {
          prop.value.properties = properties
        })
      ])
    } else if (type === 'function') {
      work.push([
        prop.value,
        () => getFunctionProperties(objectId, opts, depth + 1).then((properties) => {
          prop.value.properties = properties
        })
      ])
    }
  }

  if (work.length) {
    // Iterate over the work in chunks of 2. The closer to 1, the less we'll overshoot the deadline, but the longer it
    // takes to complete. `2` seems to be the best compromise.
    // Anecdotally, on my machine, with no deadline, a concurrency of `1` takes twice as long as a concurrency of `2`.
    // From thereon, there's no real measurable savings with a higher concurrency.
    for (let i = 0; i < work.length; i += 2) {
      if (overBudget(opts)) {
        for (let j = i; j < work.length; j++) {
          work[j][0][timeBudgetSym] = true
        }
        break
      }
      // eslint-disable-next-line no-await-in-loop
      await Promise.all([
        work[i][1](),
        work[i + 1]?.[1]()
      ])
    }
  }

  return props
}

function collectPropertiesBySubtype (subtype, objectId, opts, depth) {
  if (ITERABLE_SUBTYPES.has(subtype)) {
    return getIterable(objectId, opts, depth)
  } else if (subtype === 'promise') {
    return getInternalProperties(objectId, opts, depth)
  } else if (subtype === 'proxy') {
    return getProxy(objectId, opts, depth)
  } else if (subtype === 'arraybuffer') {
    return getArrayBuffer(objectId, opts, depth)
  }
  return collectObjectProperties(objectId, opts, depth + 1, subtype === 'array' || subtype === 'typedarray')
}

// TODO: The following extra information from `internalProperties` might be relevant to include for functions:
// - Bound function: `[[TargetFunction]]`, `[[BoundThis]]` and `[[BoundArgs]]`
// - Non-bound function: `[[FunctionLocation]]`, and `[[Scopes]]`
async function getFunctionProperties (objectId, opts, depth) {
  let { result } = await session.post('Runtime.getProperties', {
    objectId,
    ownProperties: true // exclude inherited properties
  })

  // For legacy reasons (I assume) functions has a `prototype` property besides the internal `[[Prototype]]`
  result = result.filter(({ name }) => name !== 'prototype')

  return traverseGetPropertiesResult(result, opts, depth)
}

async function getIterable (objectId, opts, depth) {
  // TODO: If the iterable has any properties defined on the object directly, instead of in its collection, they will
  // exist in the return value below in the `result` property. We currently do not collect these.
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

  removeNonEnumerableProperties(result) // remove the `length` property
  const size = result.length
  if (size > opts.maxCollectionSize) {
    result.length = opts.maxCollectionSize
    result[collectionSizeSym] = size
  }

  return traverseGetPropertiesResult(result, opts, depth)
}

async function getInternalProperties (objectId, opts, depth) {
  const { internalProperties } = await session.post('Runtime.getProperties', {
    objectId,
    ownProperties: true // exclude inherited properties
  })

  // We want all internal properties except the prototype
  const props = internalProperties.filter(({ name }) => name !== '[[Prototype]]')

  return traverseGetPropertiesResult(props, opts, depth)
}

async function getProxy (objectId, opts, depth) {
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

  return traverseGetPropertiesResult(result, opts, depth)
}

// Support for ArrayBuffer is a bit trickly because the internal structure stored in `internalProperties` is not
// documented and is not straight forward. E.g. ArrayBuffer(3) will internally contain both Int8Array(3) and
// UInt8Array(3), whereas ArrayBuffer(8) internally contains both Int8Array(8), Uint8Array(8), Int16Array(4), and
// Int32Array(2) - all representing the same data in different ways.
async function getArrayBuffer (objectId, opts, depth) {
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

  return traverseGetPropertiesResult(result, opts, depth)
}

function removeNonEnumerableProperties (props) {
  for (let i = 0; i < props.length; i++) {
    if (props[i].enumerable === false) {
      props.splice(i--, 1)
    }
  }
}

function parseLengthFromDescription (description, subtype) {
  if (typeof description !== 'string') return null
  if (!SIZE_IN_DESCRIPTION_SUBTYPES.has(subtype)) return null

  const open = description.lastIndexOf('(')
  if (open === -1) return null

  const close = description.indexOf(')', open + 1)
  if (close === -1) return null

  const s = description.slice(open + 1, close)
  if (s === '') return null

  const n = Number(s)
  if (!Number.isSafeInteger(n) || n < 0) return null
  if (String(n) !== s) return null

  return n
}

function overBudget (opts) {
  if (opts.ctx.deadlineReached) return true
  opts.ctx.deadlineReached = process.hrtime.bigint() >= opts.deadlineNs
  return opts.ctx.deadlineReached
}
