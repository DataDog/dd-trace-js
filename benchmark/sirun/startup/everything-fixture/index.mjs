import { createRequire } from 'node:module'

// Bare-specifier dynamic imports resolve against this sub-project's own
// node_modules and go through the ESM resolve/load hooks, unlike the CJS
// `require` in index.js. This is what puts the iitm ESM loader on the measured
// path when the startup bench registers it via `--import ../../../register.js`.
const { dependencies } = createRequire(import.meta.url)('./package.json')

await Promise.all(Object.keys(dependencies).map((name) => import(name)))
