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

import {
  iitmExclusions,
  load as hookLoad,
  resolve as hookResolve,
} from './loader-hook.mjs'

let hasInsertedInit = false
const initJsUrl = new URL('init.js', import.meta.url).href
// Note: `--loader` only reliably influences ESM entrypoints; for CJS apps use `--import`/`--require`.

/**
 * @param {{ source?: string|Buffer|Uint8Array, format?: string }} result
 * @param {unknown} _url_
 * @param {{ format?: string, isMain?: boolean }} context
 * @returns {{ source?: string|Buffer|Uint8Array, format?: string }}
 */
function insertInit (result, _url_, context) {
  if (hasInsertedInit) return result
  // If Node provides `isMain`, only inject into the entrypoint module.
  if (context?.isMain === false) return result

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

  const format = result.format || context?.format
  if (format !== 'module') return result

  hasInsertedInit = true

  result.source = `import ${JSON.stringify(initJsUrl)};\n${source}`

  return result
}

const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split('.').map(Number)

const brokenLoaders = NODE_MAJOR === 18 && NODE_MINOR === 0

export async function load (url, context, nextLoad) {
  const iitmExclusionsMatch = iitmExclusions.some((exclusion) => exclusion.test(url))
  const loadHook = (brokenLoaders || iitmExclusionsMatch) ? nextLoad : hookLoad
  return insertInit(await loadHook(url, context, nextLoad), url, context)
}

export const resolve = brokenLoaders ? undefined : hookResolve

if (isMainThread) {
  const require = Module.createRequire(import.meta.url)
  require('./init.js')
  if (Module.register) {
    Module.register('./loader-hook.mjs', import.meta.url, {
      data: { exclude: iitmExclusions },
    })
  }
}
