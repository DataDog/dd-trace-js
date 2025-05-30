'use strict'

const TaintedUtils = require('@datadog/native-iast-taint-tracking')
const { IAST_TRANSACTION_ID } = require('../iast-context')
const { HTTP_REQUEST_PARAMETER } = require('./source-types')
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
          if (parent) {
            parent[key] = tainted
          } else {
            result = tainted
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

function taintQueryWithCache (iastContext, query) {
  const transactionId = iastContext?.[IAST_TRANSACTION_ID]
  if (!transactionId || !query) return query

  iastContext.queryCache ??= Object.create(null)

  return traverseAndTaint(
    query,
    iastContext.queryCache,
    '',
    HTTP_REQUEST_PARAMETER,
    transactionId
  )
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
    const valueIsArray = Array.isArray(value)
    if (!cache || typeof cache !== 'object' || Array.isArray(cache) !== valueIsArray) {
      cache = valueIsArray ? [] : Object.create(null)
    }

    if (valueIsArray) {
      for (let i = 0; i < value.length; i++) {
        const childPath = path ? `${path}.${i}` : String(i)
        const taintedChild = traverseAndTaint(
          value[i],
          cache[i],
          childPath,
          type,
          transactionId
        )

        value[i] = taintedChild
        
        if (cache[i] === undefined || typeof taintedChild !== 'object') {
          cache[i] = taintedChild
        }
      }
    } else {
      for (const key of Object.keys(value)) {
        const childPath = path ? `${path}.${key}` : key
        const taintedChild = traverseAndTaint(
          value[key],
          cache[key],
          childPath,
          type,
          transactionId
        )

        value[key] = taintedChild
        
        if (cache[key] === undefined || typeof taintedChild !== 'object') {
          cache[key] = taintedChild
        }
      }
    }
  }

  return value
}

module.exports = {
  taintObject,
  taintQueryWithCache
}
