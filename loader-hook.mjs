/* eslint n/no-unsupported-features/node-builtins: ['error', { ignores: ['module.registerHooks'] }] */

import * as Module from 'node:module'
import { pathToFileURL } from 'node:url'

import { createHook, supportsSyncHooks } from 'import-in-the-middle/create-hook.mjs'
import { initialize as origInitialize, load as origLoad, resolve } from 'import-in-the-middle/hook.mjs'
import regexpEscapeModule from './vendor/dist/escape-string-regexp/index.js'
import hooks from './packages/datadog-instrumentations/src/helpers/hooks.js'
import configHelper from './packages/dd-trace/src/config/helper.js'
import * as rewriterLoader from './packages/datadog-instrumentations/src/helpers/rewriter/loader.mjs'
import { isRelativeRequire } from './packages/datadog-instrumentations/src/helpers/shared-utils.js'

// This file must support Node.js 12.0.0 syntax

const regexpEscape = regexpEscapeModule.default
const require = Module.createRequire(import.meta.url)
let syncImportInTheMiddleHook

// For some reason `getEnvironmentVariable` is not otherwise available to ESM.
const env = configHelper.getEnvironmentVariable

function initialize (data = {}) {
  prepareImportInTheMiddleOptions(data)
  return origInitialize(data)
}

function prepareImportInTheMiddleOptions (data = {}) {
  if (data.include == null) data.include = []
  if (data.exclude == null) data.exclude = []

  addInstrumentations(data)
  addSecurityControls(data)
  addExclusions(data)

  return data
}

function load (url, context, nextLoad) {
  return rewriterLoader.load(url, context, (url, context) => origLoad(url, context, nextLoad))
}

function loadSync (url, context, nextLoad) {
  if (isCommonJSRequire(context)) {
    return getSyncImportInTheMiddleHook().loadSync(url, context, nextLoad)
  }

  return rewriterLoader.loadSync(url, context, (url, context) => {
    return getSyncImportInTheMiddleHook().loadSync(url, context, nextLoad)
  })
}

function isCommonJSRequire (context) {
  const conditions = context.conditions
  if (!conditions) return false

  for (let i = 0; i < conditions.length; i++) {
    if (conditions[i] === 'require') return true
  }

  return false
}

function getSyncImportInTheMiddleHook () {
  if (syncImportInTheMiddleHook) {
    return syncImportInTheMiddleHook
  }

  const importInTheMiddleRegisterHooksUrl = pathToFileURL(
    require.resolve('import-in-the-middle/register-hooks.mjs')
  ).href
  syncImportInTheMiddleHook = createHook({ url: importInTheMiddleRegisterHooksUrl })
  return syncImportInTheMiddleHook
}

function registerSyncLoaderHooks (data = {}) {
  // The synchronous loader strips the source of a require() pulled into the iitm
  // ESM graph so Node loads it natively, but module.registerHooks rejected that
  // nullish CommonJS source until nodejs/node#59929 (released in 22.22.3, 24.11.1,
  // 25.1.0 and 26.0.0). On versions that ship registerHooks but predate the fix,
  // fall back to the asynchronous loader instead of crashing mid-graph.
  if (!supportsSyncHooks()) {
    return false
  }

  const syncHook = getSyncImportInTheMiddleHook()

  if (
    typeof Module.registerHooks !== 'function' ||
    typeof syncHook.applyOptions !== 'function' ||
    typeof syncHook.loadSync !== 'function' ||
    typeof syncHook.resolveSync !== 'function'
  ) {
    return false
  }

  // Node built-ins are instrumented under the synchronous loader as well: iitm
  // reads a built-in's exports through process.getBuiltinModule(), which
  // bypasses the registered hooks and therefore cannot re-enter them. The
  // synchronous and asynchronous loaders share the same option preparation so
  // that `import http from 'node:http'` is wrapped on both paths.
  syncHook.applyOptions(prepareImportInTheMiddleOptions(data))
  Module.registerHooks({
    resolve: syncHook.resolveSync,
    load: loadSync,
  })

  return true
}

function addInstrumentations (data) {
  const instrumentations = Object.keys(hooks)

  for (const moduleName of instrumentations) {
    // Skip instrumentation hooks with relative module names
    // since there is no current business need of instrumenting imports outside of the node_modules folder
    if (!isRelativeRequire(moduleName)) {
      data.include.push(new RegExp(`node_modules/${moduleName}/(?!node_modules).+`), moduleName)
    }
  }
}

function addSecurityControls (data) {
  const raw = env('DD_IAST_SECURITY_CONTROLS_CONFIGURATION')
  if (!raw) return
  // Parse `;`-separated entries and take the 3rd `:`-separated segment.
  // Expected form (per entry): `<...>:<...>:<subpath>:<...>`
  const entries = raw.split(';')
  for (const entry of entries) {
    if (entry) {
      const first = entry.indexOf(':')
      if (first === -1) continue
      const second = entry.indexOf(':', first + 1)
      if (second === -1) continue
      const third = entry.indexOf(':', second + 1)

      const subpath = entry.slice(second + 1, third === -1 ? undefined : third).trim()
      if (subpath) {
        data.include.push(new RegExp(regexpEscape(subpath)))
      }
    }
  }
}

function addExclusions (data) {
  data.exclude.push(...iitmExclusions)
}

export const iitmExclusions = [
  /middle/,
  /langsmith/,
  /openai\/_shims/,
  /openai\/resources\/chat\/completions\/messages/,
  /openai\/agents-core\/dist\/shims/,
  /@anthropic-ai\/sdk\/_shims/,
]

export { initialize, load, registerSyncLoaderHooks, resolve }
