/**
 * Registers the dd-trace loader hooks from an ES module. Unlike register.js, it loads the
 * synchronous hooks through `import()`, so it does not depend on require(esm), which AWS Lambda
 * disables. Without require(esm), register.js can only use the asynchronous `module.register`
 * loader, which Node.js 26 deprecates.
 */

/* eslint n/no-unsupported-features/node-builtins: ['error', { ignores: ['module.register'] }] */

import * as Module from 'node:module'

import { supportsSyncHooks } from 'import-in-the-middle/supports-sync-hooks.mjs'

import registerLoader from './packages/dd-trace/src/register-loader.js'

let registerSyncLoaderHooks

if (supportsSyncHooks()) {
  try {
    ({ registerSyncLoaderHooks } = await import('./loader-hook.mjs'))
    registerSyncLoaderHooks ??= () => false
  } catch (error) {
    registerSyncLoaderHooks = () => { throw error }
  }
}

registerLoader(Module.register, new URL(import.meta.url), registerSyncLoaderHooks)
