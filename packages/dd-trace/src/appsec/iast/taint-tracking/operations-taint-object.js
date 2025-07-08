'use strict'

const TaintedUtils = require('@datadog/native-iast-taint-tracking')
const { IAST_TRANSACTION_ID } = require('../iast-context')
const { HTTP_REQUEST_PARAMETER } = require('./source-types')
const log = require('../../../log')

const SEPARATOR = '\u0000' // Unit Separator (cannot be in URL keys)

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
        } else if (
          // eslint-disable-next-line eslint-rules/eslint-safe-typeof-object
          typeof value === 'object' && !visited.has(value)
        ) {
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

  iastContext.queryCache ??= new Map() // key: "a.b.c", value: tainted string

  traverseAndTaint(query, '', iastContext.queryCache, transactionId)
  return query
}

function traverseAndTaint (node, path, cache, transactionId) {
  if (node == null) return node

  if (typeof node === 'string') {
    const cachedValue = cache.get(path)

    if (cachedValue === node) {
      return cachedValue
    }

    const tainted = TaintedUtils.newTaintedString(transactionId, node, path, HTTP_REQUEST_PARAMETER)
    cache.set(path, tainted)

    return tainted
  }

  if (typeof node === 'object') { // eslint-disable-line eslint-rules/eslint-safe-typeof-object
    const keys = Array.isArray(node) ? node.keys() : Object.keys(node)

    for (const key of keys) {
      const childPath = path ? `${path}${SEPARATOR}${key}` : String(key)
      const tainted = traverseAndTaint(node[key], childPath, cache, transactionId)
      node[key] = tainted
    }
  }

  return node
}

module.exports = {
  taintObject,
  taintQueryWithCache
}
