'use strict'

const Module = require('node:module')

const originalRequire = Module.prototype.require

require('./register')

if (!(module instanceof Module)) {
  const hookedRequire = Module.prototype.require
  for (const name of ['http', 'https']) {
    try {
      hookedRequire.call(module, name)
    } catch {
      // Built-in not available in this environment, skip.
    }
  }

  Module.prototype.require = originalRequire
  try {
    require('http')
    require('node:http')
    require('https')
    require('node:https')
  } finally {
    Module.prototype.require = hookedRequire
  }
}
