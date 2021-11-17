'use strict'

const als = require('../als')

let lock = false // lock to prevent recursive calls to runSubscriptions

function runSubscriptions (subscriptions, params) {
  const results = []

  if (lock || !subscriptions.size) return results
  lock = true

  const store = als.getStore()

  const executedCallbacks = new Set()

  for (const subscription of subscriptions) {
    if (executedCallbacks.has(subscription.callback)) continue
    executedCallbacks.add(subscription.callback)

    let result

    try {
      result = subscription.callback.method(params, store)
    } catch (err) {
      // TODO: log ?
      result = {}
    }

    results.push(result)
  }

  lock = false

  return results
}

module.exports = {
  runSubscriptions
}
