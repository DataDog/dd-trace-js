'use strict'

const TaintedUtils = require('@datadog/native-iast-taint-tracking')
const { IAST_TRANSACTION_ID } = require('../iast-context')
const log = require('../../../log')

function taintObject (iastContext, object, type) {
  let result = object
  const transactionId = iastContext?.[IAST_TRANSACTION_ID]
  if (transactionId) {
    const queue = [{ parent: null, property: null, value: object }]
    const visited = new WeakSet()

    while (queue.length > 0) {
      const { parent, property, value, key } = queue.pop()
      if (value === null) {
        continue
      }

      try {
        if (typeof value === 'string') {
          const tainted = TaintedUtils.newTaintedString(transactionId, value, property, type)
          if (!parent) {
            result = tainted
          } else {
            parent[key] = tainted
          }
        } else if (typeof value === 'object' && !visited.has(value)) {
          visited.add(value)

          for (const key of Object.keys(value)) {
            queue.push({ parent: value, property: property ? `${property}.${key}` : key, value: value[key], key })
          }
        }
      } catch (e) {
        log.error('[ASM] Error in taintObject when visiting property : %s', property, e)
      }
    }
  }
  return result
}

function taintQueryWithCache (iastContext, query, type) {
  const transactionId = iastContext?.[IAST_TRANSACTION_ID]
  if (!transactionId || !query) return

  if (!iastContext.queryCache) {
    iastContext.queryCache = {}
  }

  return traverseAndTaint(query, iastContext.queryCache, '', type, transactionId)
}

function traverseAndTaint (value, cache, path, type, transactionId) {
  if (value == null) return value

  if (typeof value === 'string') {
    // If we already have a tainted version of this exact string in the cache
    if (value === cache) {
      return cache
    }

    return TaintedUtils.newTaintedString(transactionId, value, path, type)
  }

  if (typeof value === 'object') {
    const isArray = Array.isArray(value)
    if (!cache || typeof cache !== 'object' || Array.isArray(cache) !== isArray) {
      cache = isArray ? [] : Object.create(null)
    }

    for (const key of Object.keys(value)) {
      const childPath = path ? `${path}.${key}` : key
      const childValue = value[key]

      value[key] = traverseAndTaint(
        childValue,
        cache[key],
        childPath,
        type,
        transactionId
      )

      cache[key] = value[key]
    }
  }

  return value
}

module.exports = {
  taintObject,
  taintQueryWithCache
}
