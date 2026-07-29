import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { toHook } = require('import-in-the-middle/lib/register')

await import('./unrelated-module.mjs')
const unrelatedStayedUnwrapped = toHook.length === 0

await import('node:http')

// eslint-disable-next-line no-console
console.log(unrelatedStayedUnwrapped && toHook.length === 1 && toHook[0][0] === 'node:http')
process.exit()
