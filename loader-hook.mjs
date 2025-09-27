import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

// TODO(bengl) This is all here because IITM imports a CommonJS module. Once
// that's fixed in IITM, we no longer need all this.
const iitmPath = createRequire(import.meta.url).resolve('import-in-the-middle/hook.mjs')
const { createHook } = createRequire(iitmPath)('./hook.js')
const iitmMeta = { url: pathToFileURL(iitmPath).toString() }
const { initialize, load, resolve, getFormat, getSource } = createHook(iitmMeta)
export { initialize, load, resolve, getFormat, getSource }
