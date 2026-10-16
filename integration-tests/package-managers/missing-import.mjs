import { types } from 'node:util'

// pnpm 11.0-11.20 only treats its optional `.pnpmfile.mjs` as absent when this import error is native.
try {
  await import(new URL('missing.mjs', import.meta.url).href)
} catch (error) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ code: error.code, isNativeError: types.isNativeError(error) }))
}
