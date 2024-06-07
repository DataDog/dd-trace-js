/**
  * This file serves one of two purposes, depending on how it's used.
  *
  * If used with --import, it will import init.js and register the loader hook.
  * If used with --loader, it will act as the loader hook, except that it will
  * also import init.js inside the source code of the entrypoint file.
  *
  * The result is that no matter how this file is used, so long as it's with
  * one of the two flags, the tracer will always be initialized, and the loader
  * hook will always be active for ESM support.
  */

import { isMainThread } from 'worker_threads'

import { fileURLToPath } from 'node:url'
import {
  load as origLoad,
  resolve as origResolve,
  getFormat as origGetFormat,
  getSource as origGetSource
} from 'import-in-the-middle/hook.mjs'

let hasInsertedInit = false
function insertInit (result) {
  if (!hasInsertedInit) {
    hasInsertedInit = true
    result.source = `
import '${fileURLToPath(new URL('./init.js', import.meta.url))}';
${result.source}`
  }
  return result
}

export async function load (...args) {
  return insertInit(await origLoad(...args))
}

export const resolve = origResolve

export const getFormat = origGetFormat

export async function getSource (...args) {
  return insertInit(await origGetSource(...args))
}

if (isMainThread) {
  await import('./init.js')
  const { register } = await import('node:module')
  if (register) {
    register('./loader-hook.mjs', import.meta.url)
  }
}
