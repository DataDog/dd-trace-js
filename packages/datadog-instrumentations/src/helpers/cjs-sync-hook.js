'use strict'

// Runtime support for instrumenting CommonJS modules through the synchronous
// loader hooks (module.registerHooks) instead of require-in-the-middle's
// `Module.prototype.require` wrapper.
//
// The sync `load` hook only gets a module's *source*, not its evaluated
// `module.exports`. For an instrumented module we append a small shim to the CJS
// source: after the module finishes evaluating, the shim calls
// `applyCjsHooks(module.exports, filename)`, which runs the same per-module hook
// callback RITM runs — wrapping the *native, mutable* exports in place (no ESM
// namespace proxy, so `Object.defineProperty(require('fs'), ...)` and
// `class X extends require('events')` keep working).
//
// RITM keeps owning CJS on Node versions without the sync hooks; this path is
// only active where the combined sync hook has taken over (see register.js).

const path = require('path')
const { builtinModules } = require('module')

const parse = require('../../../../vendor/dist/module-details-from-path')
const requirePackageJson = require('../../../dd-trace/src/require-package-json')

const BUILTINS = new Set(builtinModules)

/**
 * @typedef {(exports: unknown, name: string, basedir: string|undefined,
 *   version: string|undefined, isIitm: boolean) => unknown} OnRequire
 */

/** @type {Map<string, OnRequire[]>} keyed by package name (RITM's hook table). */
const moduleHooks = new Map()

/** @type {WeakSet<object>} Already-wrapped exports, to stay idempotent. */
const wrapped = new WeakSet()

/** @type {Map<string, string|undefined>} basedir -> resolved version. */
const versionCache = new Map()

// process.getBuiltinModule lands in Node 22.3 / backported to 20.16; the sync
// loader only owns CJS on Node ≥22.22.3, so it is always present there, but the
// repo's supported floor is 18 — guard the reference.
const getBuiltinModule =
  // eslint-disable-next-line n/no-unsupported-features/node-builtins -- guarded; only reached on Node >=22.22.3
  typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule : undefined

/**
 * Registers a hook callback for a package name. Mirrors RITM's hook table so the
 * sync path and RITM run the identical per-module callback.
 *
 * @param {string} name Package name (e.g. 'http', 'express', '@langchain/core').
 * @param {OnRequire} onrequire
 * @returns {void}
 */
function registerCjsHook (name, onrequire) {
  const existing = moduleHooks.get(name)
  if (existing) {
    existing.push(onrequire)
  } else {
    moduleHooks.set(name, [onrequire])
  }

  // Builtins have no source for the load-hook shim, but they are singletons:
  // wrapping the live exports object now is seen by every later require(name),
  // at zero per-require cost. The async loader path does not reach here, so this
  // only runs where the sync loader owns CJS.
  if (BUILTINS.has(name) && getBuiltinModule !== undefined) {
    wrapBuiltin(name, onrequire)
  }
}

/**
 * @param {string} name Builtin module name.
 * @param {OnRequire} onrequire
 * @returns {void}
 */
function wrapBuiltin (name, onrequire) {
  const exports = getBuiltinModule(name)
  if (exports === undefined) return
  // Run the hook in place; integrations mutate the singleton's properties.
  onrequire(exports, name, undefined, process.version, false)
}

/**
 * Resolves a loaded file path to the registered package and the RITM-style
 * module name (`<package>/<relative-path>`), or undefined when no hook is
 * registered for the owning package. Builtins (no basedir) map to the bare name.
 *
 * @param {string} filename Absolute resolved file path, or a `node:`-stripped builtin name.
 * @returns {{ packageName: string, moduleName: string, basedir: string|undefined }|undefined}
 */
function matchModule (filename) {
  // Builtins arrive as a bare module id (e.g. 'http'); they have no path.
  if (!filename.includes(path.sep)) {
    return moduleHooks.has(filename)
      ? { packageName: filename, moduleName: filename, basedir: undefined }
      : undefined
  }

  const stat = parse(filename)
  if (!stat) return

  const packageName = stat.name
  const hooks = moduleHooks.get(packageName)
  if (!hooks) return

  // RITM keys file-specific hooks as `<name>/<relative path>`; the package main
  // is matched against the integration's `file` (default 'index.js') inside the
  // registered callback, so build the same moduleName here.
  const moduleName = `${packageName}${path.sep}${path.relative(stat.basedir, filename)}`.replaceAll('\\', '/')
  return { packageName, moduleName, basedir: stat.basedir }
}

/**
 * @param {string|undefined} basedir
 * @returns {string|undefined}
 */
function resolveVersion (basedir) {
  if (!basedir) return process.versions?.electron ?? process.version
  if (versionCache.has(basedir)) return versionCache.get(basedir)
  let version
  try {
    version = requirePackageJson(basedir, /** @type {NodeModule} */ (module)).version
  } catch {}
  versionCache.set(basedir, version)
  return version
}

/**
 * Applies the registered hook to a freshly evaluated CommonJS module's exports,
 * in place. Called by the shim appended to instrumented CJS source.
 *
 * @param {unknown} moduleExports The module's evaluated `module.exports`.
 * @param {string} filename Absolute resolved file path of the module.
 * @returns {unknown} The (possibly wrapped) exports to assign back.
 */
function applyCjsHooks (moduleExports, filename) {
  if (moduleExports && typeof moduleExports === 'object' && wrapped.has(moduleExports)) {
    return moduleExports
  }

  const match = matchModule(filename)
  if (!match) return moduleExports

  const hooks = moduleHooks.get(match.packageName)
  const version = resolveVersion(match.basedir)

  let result = moduleExports
  for (const hook of hooks) {
    result = hook(result, match.moduleName, match.basedir, version, false) ?? result
  }

  if (result && typeof result === 'object') wrapped.add(result)
  return result
}

/**
 * Whether the package that owns `filename` has a registered hook. Lets the
 * loader skip appending the shim to uninstrumented CJS modules.
 *
 * @param {string} filename Absolute resolved file path.
 * @returns {boolean}
 */
function hasCjsHook (filename) {
  return matchModule(filename) !== undefined
}

module.exports = { registerCjsHook, applyCjsHooks, hasCjsHook, moduleHooks }
