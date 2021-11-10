'use strict'

const als = require('../als')
const lockName = 'ddRunnerLock' // TODO: do we really need this (to be global) ?

function runSubscriptions (subscriptions, params) {
  const results = []

  if (!subscriptions.size || process[lockName]) return results
  process[lockName] = true

  const store = als.getStore()

  const executedCallbacks = new Set()

  subscriptions.forEach((subscription) => {
    if (executedCallbacks.has(subscription.callback)) return
    executedCallbacks.add(subscription.callback)

    let result

    try {
      result = subscription.callback.method(params, store)
    } catch (err) {
      // TODO: log ?
      result = {}
    }

    results.push(result)
  })

  process[lockName] = false

  return results
}

module.exports = {
  runSubscriptions
}
