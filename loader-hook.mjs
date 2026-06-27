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

const { builtinModules } = Module
const regexpEscape = regexpEscapeModule.default
const require = Module.createRequire(import.meta.url)
let syncImportInTheMiddleHook

// The config helper's named exports aren't visible to ESM; destructure the default.
const { getValueFromEnvSources } = configHelper

// Substrings of resolved URLs that import-in-the-middle must never wrap: re-export
// shims and internal helper graphs that break when proxied, plus iitm's own files
// (via `middle`). One alternation so a single test() covers every excluded load.
export const iitmExclusionRegExp = /middle|langsmith|openai\/_shims|openai\/resources\/chat\/completions\/messages|openai\/agents-core\/dist\/shims|@anthropic-ai\/sdk\/_shims/

// Instrumented bare specifiers (`import 'express'`, builtins, symlinked or
// workspace packages) match against the specifier (the Set); their files inside
// node_modules match against the URL (the alternation). regexpEscape guards
// against a regex metacharacter entering a package name.
const includeModuleNames = new Set()
let moduleNameAlternation = ''
for (const moduleName of Object.keys(hooks)) {
  // Relative hooks resolve outside node_modules and are not instrumented here.
  if (isRelativeRequire(moduleName)) continue
  includeModuleNames.add(moduleName)
  // iitm matches a built-in by its node: specifier too, so mirror that and
  // wrap `import 'node:crypto'` as well as `import 'crypto'`.
  if (builtinModules.includes(moduleName)) includeModuleNames.add(`node:${moduleName}`)
  if (moduleNameAlternation !== '') moduleNameAlternation += '|'
  moduleNameAlternation += regexpEscape(moduleName)
}

const nodeModulesIncludeSource = `node_modules/(?:${moduleNameAlternation})/(?!node_modules).+`

function initialize (data = {}) {
  prepareImportInTheMiddleOptions(data)
  return origInitialize(data)
}

function prepareImportInTheMiddleOptions (data = {}) {
  // A consumer-owned shouldInclude predicate takes over the wrapping decision, so
  // iitm ignores the include/exclude arrays. Building the matcher here keeps the
  // synchronous and asynchronous loaders on one matching implementation.
  data.shouldInclude = createShouldInclude(getValueFromEnvSources('DD_IAST_SECURITY_CONTROLS_CONFIGURATION'))

  return data
}

/**
 * Builds the import-in-the-middle `shouldInclude(url, specifier)` predicate. iitm
 * calls it for every resolved module and wraps the module when the result is
 * truthy; supplying it replaces iitm's include/exclude list scan.
 *
 * @param {string} [securityControlsConfig] Raw `DD_IAST_SECURITY_CONTROLS_CONFIGURATION`;
 *   each entry's module path is instrumented in addition to the hook table.
 */
function createShouldInclude (securityControlsConfig) {
  const includeRegExp = new RegExp(buildIncludeSource(securityControlsConfig))

  /**
   * @param {string} url Resolved module URL (`file:`, `node:`, ...).
   * @param {string} specifier Original import specifier.
   */
  return function shouldInclude (url, specifier) {
    return (includeModuleNames.has(specifier) || includeRegExp.test(url)) && !iitmExclusionRegExp.test(url)
  }
}

/**
 * Appends each `DD_IAST_SECURITY_CONTROLS_CONFIGURATION` module path — the third
 * `:`-separated segment of every `;`-separated `<type>:<marks>:<module>:<...>` entry —
 * to the include alternation, escaped.
 *
 * @param {string} [securityControlsConfig] Raw `DD_IAST_SECURITY_CONTROLS_CONFIGURATION`.
 */
function buildIncludeSource (securityControlsConfig) {
  if (!securityControlsConfig) return nodeModulesIncludeSource

  let includeSource = nodeModulesIncludeSource
  for (const entry of securityControlsConfig.split(';')) {
    if (!entry) continue
    const first = entry.indexOf(':')
    if (first === -1) continue
    const second = entry.indexOf(':', first + 1)
    if (second === -1) continue
    const third = entry.indexOf(':', second + 1)

    const subpath = entry.slice(second + 1, third === -1 ? undefined : third).trim()
    if (subpath) includeSource += `|${regexpEscape(subpath)}`
  }
  return includeSource
}

function load (url, context, nextLoad) {
  return rewriterLoader.load(url, context, (url, context) => origLoad(url, context, nextLoad))
}

let resolveSyncHook

// Short-circuit builtins before import-in-the-middle resolve sees them. iitm
// otherwise wraps a builtin and later reads its source via getExports; a builtin
// resolved synchronously without builtin format (e.g. require("util") compiled
// into a Debugger.evaluateOnCallFrame expression, or a CJS re-export of a
// builtin) then reaches readFileSync("util") and throws ENOENT. Builtins are
// instrumented separately (iitm getBuiltinModule / RITM), so leave them for
// Node to resolve natively.
function resolveSync (specifier, context, nextResolve) {
  if (typeof specifier === 'string' &&
      (specifier.startsWith('node:') || builtinModules.includes(specifier))) {
    return nextResolve(specifier, context)
  }
  return resolveSyncHook(specifier, context, nextResolve)
}

function loadSync (url, context, nextLoad) {
  if (isCommonJSLoad(context)) {
    return getSyncImportInTheMiddleHook().loadSync(url, context, nextLoad)
  }

  return rewriterLoader.loadSync(url, context, (url, context) => {
    return getSyncImportInTheMiddleHook().loadSync(url, context, nextLoad)
  })
}

function isCommonJSLoad (context) {
  if (context.format) return context.format === 'commonjs'

  // Sync hooks report CommonJS require() dependency loads with a `require`
  // condition but no format. If a format is present, trust it instead: ESM
  // loaded through require() reports `format: 'module'` and still needs rewrite.
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
  resolveSyncHook = syncHook.resolveSync
  Module.registerHooks({
    resolve: resolveSync,
    load: loadSync,
  })

  return true
}

export { initialize, load, registerSyncLoaderHooks, resolve }
