// ESM loader hook that loads the CJS channel-patch module.
// The module patching happens as a side effect of the require().
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
require('./channel-patch.js')
