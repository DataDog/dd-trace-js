/**
 * This file serves one of two purposes, depending on how it's used.
 *
 * If used with --import, it will import init.js and register the loader hook.
 * If used with --loader, it will act as the loader hook.
 *
 * The result is that no matter how this file is used, so long as it's with
 * one of the two flags, the tracer will always be initialized, and the loader
 * hook will always be active for ESM support.
 */

/* eslint n/no-unsupported-features/node-builtins: ['error', { ignores: ['module.register'] }] */

import { Buffer } from 'buffer'
import * as Module from 'module'
import { types } from 'util'
import { isMainThread } from 'worker_threads'

// This file must support Node.js 14.13.1 syntax

const NODE_VERSION = process.versions.node

const brokenLoaders = NODE_VERSION.startsWith('18.0')
const isNode20LoaderWorker = !isMainThread && NODE_VERSION.startsWith('20.0')
const useDefaultLoader = brokenLoaders || isNode20LoaderWorker
// Avoid CommonJS in the loader worker on Node 20.0: https://github.com/nodejs/node/issues/47566
const loaderHook = useDefaultLoader ? undefined : await import('./loader-hook.mjs?initialize')

let hasInsertedInit = false
const initJsUrl = new URL('init.js', import.meta.url).href
// `--loader` only reliably influences ESM entrypoints; for CJS apps use `--import`/`--require`.

// `globalPreload` is deprecated in favor of the `initialize` hook, but `initialize` only exists
// from Node 20.6 on, so it is the only way to run code in the application realm on Node 20.0.
export const globalPreload = isNode20LoaderWorker
  ? () => `if (getBuiltin('module').createRequire(${JSON.stringify(import.meta.url)})('./init.js')) {
  process.emitWarning('dd-trace cannot instrument ES modules on Node.js 20.0.0. Upgrade to Node.js 20.1.0 or newer.')
}`
  : undefined

/**
 * @param {{ source?: string|Buffer|Uint8Array, format?: string }} result
 * @param {unknown} _url_
 * @param {{ format?: string, isMain?: boolean }} context
 * @returns {{ source?: string|Buffer|Uint8Array, format?: string }}
 */
function insertInit (result, _url_, context) {
  if (hasInsertedInit) return result
  // If Node provides `isMain`, only inject into the entrypoint module.
  if (context && context.isMain === false) return result

  let { source } = result
  if (typeof source !== 'string') {
    // Fast decode: handle bytes sources without extra copies when possible.
    if (Buffer.isBuffer(source)) {
      source = source.toString('utf8')
    } else if (types.isUint8Array(source)) {
      // Create a Buffer view over the same ArrayBuffer segment (no copy).
      source = Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString('utf8')
    } else {
      return result
    }
  }

  const format = result.format || (context && context.format)
  if (format !== 'module') return result

  hasInsertedInit = true

  result.source = `import ${JSON.stringify(initJsUrl)};\n${source}`

  return result
}

// Node calls `initialize` only through `module.register`, never for `--loader`; without it
// import-in-the-middle keeps its default matcher and proxies every application module. Loaders
// before Node 18.19 share the application thread, where `loader-hook.mjs` builds no matcher.
let needsHookInitialize = !isMainThread && !useDefaultLoader

/**
 * @param {string} url
 * @param {import('node:module').LoadHookContext & { isMain?: boolean }} context
 * @param {Parameters<import('node:module').LoadHook>[2]} nextLoad
 */
async function loadWithInit (url, context, nextLoad) {
  if (needsHookInitialize) {
    needsHookInitialize = false
    loaderHook.initialize()
  }

  const load = (useDefaultLoader || loaderHook.iitmExclusionRegExp.test(url)) ? nextLoad : loaderHook.load
  return insertInit(await load(url, context, nextLoad), url, context)
}

export const load = isNode20LoaderWorker ? undefined : loadWithInit
export const resolve = useDefaultLoader ? undefined : loaderHook.resolve

if (isMainThread) {
  const require = Module.createRequire(import.meta.url)
  const initialized = require('./init.js')
  // Only register the loader hook when instrumentation initialized. On a bailout the
  // loader has nothing to instrument and can keep a short-lived process from exiting.
  if (Module.register && initialized) {
    // The loader builds its own include/exclude matcher in `initialize`, so no
    // options need to cross the registration boundary.
    Module.register('./loader-hook.mjs', import.meta.url)
  }
}
