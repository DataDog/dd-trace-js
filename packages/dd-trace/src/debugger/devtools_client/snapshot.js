'use strict'

const { breakpoints } = require('./state')
const session = require('./session')

module.exports = {
  getLocalStateForBreakpoint
}

async function getLocalStateForBreakpoint (params) {
  const scope = params.callFrames[0].scopeChain[0] // TODO: Should we only ever look at the top?
  const conf = breakpoints.get(params.hitBreakpoints[0]) // TODO: Handle multiple breakpoints
  return toObject(await getObjectWithChildren(scope.object.objectId, conf)).fields
}

async function getObjectWithChildren (objectId, conf, depth = 0) {
  const { result } = (await session.post('Runtime.getProperties', {
    objectId,
    ownProperties: true // exclude inherited properties
    // TODO: Remove the following commented out lines before shipping
    // accessorPropertiesOnly: true, // true: only return get/set accessor properties
    // generatePreview: true, // true: generate `value.preview` object with details (including content) of maps and sets
    // nonIndexedPropertiesOnly: true // true: do not get array elements
  }))

  // TODO: Deside if we should filter out enumerable properties or not:
  // result = result.filter((e) => e.enumerable)

  if (depth < conf.capture.maxReferenceDepth) {
    for (const entry of result) {
      if (entry?.value?.type === 'object' && entry?.value?.objectId) {
        entry.value.properties = await getObjectWithChildren(entry.value.objectId, conf, depth + 1)
      }
    }
  }

  return result
}

function toObject (state) {
  if (state === undefined) {
    return {
      type: 'object',
      notCapturedReason: 'depth'
    }
  }

  const result = {
    type: 'object',
    fields: {}
  }

  for (const prop of state) {
    result.fields[prop.name] = getPropVal(prop)
  }

  return result
}

function toArray (state) {
  if (state === undefined) {
    return {
      type: 'array', // TODO: Should this be 'object' as typeof x === 'object'?
      notCapturedReason: 'depth'
    }
  }

  const result = {
    type: 'array', // TODO: Should this be 'object' as typeof x === 'object'?
    elements: []
  }

  for (const elm of state) {
    if (elm.enumerable === false) continue // the value of the `length` property should not be part of the array
    result.elements.push(getPropVal(elm))
  }

  return result
}

function getPropVal (prop) {
  const value = prop.value ?? prop.get
  switch (value.type) {
    case 'undefined':
      return {
        type: 'undefined',
        value: undefined // TODO: We can't send undefined values over JSON
      }
    case 'boolean':
      return {
        type: 'boolean',
        value: value.value
      }
    case 'string':
      return {
        type: 'string',
        value: value.value
      }
    case 'number':
      return {
        type: 'number',
        value: value.value
      }
    case 'bigint':
      return {
        type: 'bigint',
        value: value.description
      }
    case 'symbol':
      return {
        type: 'symbol',
        value: value.description // TODO: Should we really send this as a string?
      }
    case 'function':
      return {
        type: value.description.startsWith('class ') ? 'class' : 'function'
      }
    case 'object':
      return getObjVal(value)
    default:
      throw new Error(`Unknown type "${value.type}": ${JSON.stringify(prop)}`)
  }
}

function getObjVal (obj) {
  switch (obj.subtype) {
    case undefined:
      return toObject(obj.properties)
    case 'array':
      return toArray(obj.properties)
    case 'null':
      return {
        type: 'null', // TODO: Should this be 'object' as typeof x === 'null'?
        isNull: true
      }
    case 'set':
      return {
        type: 'set', // TODO: Should this be 'object' as typeof x === 'object'?
        value: obj.description // TODO: Should include Set content in 'elements'
      }
    case 'map':
      return {
        type: 'map', // TODO: Should this be 'object' as typeof x === 'object'?
        value: obj.description // TODO: Should include Map content 'entries'
      }
    case 'regexp':
      return {
        type: 'regexp', // TODO: Should this be 'object' as typeof x === 'object'?
        value: obj.description // TODO: This doesn't seem right
      }
    default:
      throw new Error(`Unknown subtype "${obj.subtype}": ${JSON.stringify(obj)}`)
  }
}
