'use strict'

const hooks = require('./hooks')

module.exports = function registerInstrumentation (name) {
  const hook = hooks[name]
  const hookFn = hook?.fn ?? hook

  if (typeof hookFn === 'function') hookFn()
}
