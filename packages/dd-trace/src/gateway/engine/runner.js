'use strict'

const lockName = 'ddRunnerLock'

function runSubscriptions (subscriptions, params) {
  if (!subscriptions.length || process[lockName]) return []
  process[lockName] = true

  const results = []

  for (let i = 0; i < subscriptions.length; ++i) {
    const subscription = subscriptions[i]
    let result

    try {
      result = subscription.callback.method(params, subscription)
    } catch (err) {
      // log ?
      result = {}
    }

    results.push(result)
  }

  process[lockName] = false

  return results
}

module.exports = {
  runSubscriptions
}
