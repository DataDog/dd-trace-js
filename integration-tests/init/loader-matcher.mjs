import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { toHook } = require('import-in-the-middle/lib/register')

await import('./unrelated-module.mjs')
const unrelatedStayedUnwrapped = toHook.length === 0

await import('./security-control-module.mjs')
const securityControlWasWrapped = toHook.length === 1 &&
  toHook[0][0] === new URL('./security-control-module.mjs', import.meta.url).href

await import('node:http')

// eslint-disable-next-line no-console
console.log(
  unrelatedStayedUnwrapped && securityControlWasWrapped && toHook.length === 2 && toHook[1][0] === 'node:http'
)
process.exit()
