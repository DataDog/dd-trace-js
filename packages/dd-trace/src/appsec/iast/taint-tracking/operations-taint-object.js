'use strict'

const TaintedUtils = require('@datadog/native-iast-taint-tracking')
const { IAST_TRANSACTION_ID } = require('../iast-context')
const iastLog = require('../iast-log')

// @see packages/dd-trace/test/appsec/iast/taint-tracking/taint-tracking-operations.spec.js
function taintObject (iastContext, object, type, keyTainting, keyType) {
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
          } else if (keyTainting && key) {
            const taintedProperty = TaintedUtils.newTaintedString(transactionId, key, property, keyType)
            parent[taintedProperty] = tainted
          } else {
            parent[key] = tainted
          }
        } else if (typeof value === 'object' && !visited.has(value)) {
          visited.add(value)

          for (const key of Object.keys(value)) {
            queue.push({ parent: value, property: property ? `${property}.${key}` : key, value: value[key], key })
          }

          if (parent && keyTainting && key) {
            const taintedProperty = TaintedUtils.newTaintedString(transactionId, key, property, keyType)
            parent[taintedProperty] = value
          }
        }
      } catch (e) {
        iastLog.error(`Error visiting property : ${property}`).errorAndPublish(e)
      }
    }
  }
  return result
}

module.exports = {
  taintObject
}
