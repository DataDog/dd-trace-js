'use strict'

const callbacks = require('./callbacks')

const appliedCallbacks = new Map()

function applyRules (rules, config) {
  if (appliedCallbacks.has(rules)) return

  // for now there is only WAF
  const callback = new callbacks.DDWAF(rules, config)

  appliedCallbacks.set(rules, callback)
}

function clearAllRules () {
  for (const [key, callback] of appliedCallbacks) {
    callback.clear()

    appliedCallbacks.delete(key)
  }
}

module.exports = {
  applyRules,
  clearAllRules
}
