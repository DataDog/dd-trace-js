import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { toHook } = require('import-in-the-middle/lib/register')
const wrappedModules = toHook.length

await import('./unrelated-module.mjs')

// eslint-disable-next-line no-console
console.log(toHook.length === wrappedModules)
process.exit()
