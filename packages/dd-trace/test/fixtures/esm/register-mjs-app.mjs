/* eslint n/no-unsupported-features/node-builtins: [
  'error', { ignores: ['module.register', 'module.registerHooks'] }
] */

import Module from 'node:module'

const mode = process.argv[2]
const { register } = Module
const registerHooks = /** @type {{ registerHooks?: (options: object) => object }} */ (Module).registerHooks
let asyncRegistrations = 0
let syncRegistrations = 0
if (mode === 'without-async-loader') {
  Reflect.deleteProperty(Module, 'register')
} else if (register) {
  Reflect.set(Module, 'register', function (specifier, parentURL, options) {
    asyncRegistrations++
    return register(specifier, parentURL, options)
  })
}
if (mode === 'without-sync-hooks') {
  Reflect.deleteProperty(Module, 'registerHooks')
} else if (registerHooks) {
  Reflect.set(Module, 'registerHooks', function (options) {
    syncRegistrations++
    return registerHooks(options)
  })
}
Module.syncBuiltinESMExports()

if (mode === 'commonjs-first') {
  await import('../../../../../register.js')
}
if (mode === 'without-async-loader' || mode === 'commonjs-first' || mode === 'initialize-first') {
  await import('../../../../../initialize.mjs')
} else {
  await import('../../../../../register.mjs')
}
if (mode === 'initialize-first') {
  await import('../../../../../register.js')
}

const { Hook } = await import('import-in-the-middle')
let wrapped = false
// eslint-disable-next-line no-new
new Hook(['dns'], (exports) => {
  wrapped = true
  return exports
})
await import('node:dns')

process.stdout.write(JSON.stringify({ wrapped, asyncRegistrations, syncRegistrations }))
