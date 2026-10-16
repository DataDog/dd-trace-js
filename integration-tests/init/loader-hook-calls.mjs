/* eslint n/no-unsupported-features/node-builtins: ['error', {
  ignores: ['module.register', 'module.registerHooks']
}] */

import module from 'node:module'

// Preloaded ahead of dd-trace so the entrypoint can report which loader API it used.
const calls = { register: 0, registerHooks: 0 }
globalThis._ddLoaderHookCalls = calls

const { register, registerHooks } = module

if (register) {
  module.register = function (...args) {
    calls.register++
    return register.apply(this, args)
  }
}

if (registerHooks) {
  module.registerHooks = function (...args) {
    calls.registerHooks++
    return registerHooks.apply(this, args)
  }
}

module.syncBuiltinESMExports()
