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

import * as Module from 'node:module'
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

const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split('.').map(x => +x)

const brokenLoaders = NODE_MAJOR === 18 && NODE_MINOR === 0

export async function load (...args) {
  const loadHook = brokenLoaders ? args[args.length - 1] : origLoad
  return insertInit(await loadHook(...args))
}

export const resolve = brokenLoaders ? undefined : origResolve

export const getFormat = origGetFormat

export async function getSource (...args) {
  return insertInit(await origGetSource(...args))
}

if (isMainThread) {
  const require = Module.createRequire(import.meta.url)
  require('./init.js')
  if (Module.register) {
    Module.register('./loader-hook.mjs', import.meta.url)
  }
}
