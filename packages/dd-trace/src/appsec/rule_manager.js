'use strict'

const callbacks = require('./callbacks')

const appliedCallbacks = new Map()

function applyRules (rules) {
  // for now there is only WAF
  const callback = new callbacks.DDWAF(rules)

  appliedCallbacks.set(rules, callback)
}

function clearAllRules () {
  for (const [, callback] of appliedCallbacks) {
    callback.clear()
  }
}

module.exports = {
  applyRules,
  clearAllRules
}
