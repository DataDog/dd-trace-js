'use strict'

const { builtinModules } = require('node:module')

const hooks = require('./hooks')
const instrumentations = require('./instrumentations')

for (const hook of Object.values(hooks)) {
  if (hook !== null && typeof hook === 'object') {
    hook.fn()
  } else {
    hook()
  }
}

const builtinModuleNames = new Set(builtinModules)
const modules = new Set()

for (const [name, entries] of Object.entries(instrumentations)) {
  for (const { file } of entries) {
    modules.add(file ? `${name}/${file}` : name)
    if (builtinModuleNames.has(name)) {
      modules.add(file ? `node:${name}/${file}` : `node:${name}`)
    }
  }
}

module.exports = modules
