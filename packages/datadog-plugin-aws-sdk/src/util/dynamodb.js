const { generatePointerHash } = require('../../../dd-trace/src/util')

const encodeValue = (valueObject) => {
  if (!valueObject) return ''
  try {
    const type = Object.keys(valueObject)[0]
    const value = valueObject[type]
    if (!value) return ''
    return Buffer.from(String(value))
  } catch (err) {
    console.log('Unable to encode valueObject:', valueObject)
  }
}

const extractPrimaryKeys = (keySet, valueSource) => {
  const keyNames = keySet instanceof Set
    ? Array.from(keySet)
    : Object.keys(keySet)

  if (keyNames.length === 1) {
    return [keyNames[0], encodeValue(valueSource[keyNames[0]]), '', '']
  } else {
    const [key1, key2] = keyNames.sort()
    return [
      key1,
      encodeValue(valueSource[key1]),
      key2,
      encodeValue(valueSource[key2])
    ]
  }
}

const calculatePutItemHash = (tableName, item, primaryKeyConfig) => {
  const primaryKeySet = primaryKeyConfig[tableName]
  if (!primaryKeySet || !(primaryKeySet instanceof Set) || primaryKeySet.size === 0 || primaryKeySet.size > 2) {
    console.log('Invalid dynamo primary key config:', primaryKeyConfig)
    return
  }
  const keyValues = extractPrimaryKeys(primaryKeySet, item)
  console.log('[TRACER] keyValues:', keyValues)
  return generatePointerHash([tableName, ...keyValues])
}

const calculateKeyBasedOperationsHash = (tableName, keys) => {
  const keyValues = extractPrimaryKeys(keys, keys)
  console.log('[TRACER] keyValues:', keyValues)
  return generatePointerHash([tableName, ...keyValues])
}

module.exports = {
  calculatePutItemHash,
  calculateKeyBasedOperationsHash
}
