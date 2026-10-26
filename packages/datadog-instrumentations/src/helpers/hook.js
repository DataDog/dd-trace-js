'use strict'

const path = require('path')

const iitm = require('../../../dd-trace/src/iitm')
const ritm = require('../../../dd-trace/src/ritm')
const log = require('../../../dd-trace/src/log')
const requirePackageJson = require('../../../dd-trace/src/require-package-json')
const { isNodeBuiltinModuleName } = require('./shared-utils')

/**
 * @param {string} moduleBaseDir
 * @returns {string|undefined}
 */
function getVersion (moduleBaseDir) {
  if (moduleBaseDir) {
    return requirePackageJson(moduleBaseDir, /** @type {import('module').Module} */ (module)).version
  }

  // In a packaged Electron binary, built-in modules (like 'electron', 'electron/main') have no
  // moduleBaseDir. Use the Electron version for version checks when available, otherwise fall back
  // to the Node.js version.
  return process.versions?.electron ?? process.version
}

/**
 * @param {Record<string, unknown>} namespace
 * @param {unknown} moduleExports
 */
function syncExports (namespace, moduleExports) {
  for (const key of Object.keys(namespace)) {
    if (key === 'default' || key === 'module.exports') {
      namespace[key] = moduleExports
    } else if (moduleExports != null && Object.hasOwn(moduleExports, key)) {
      const wrapped = moduleExports[key]
      if (namespace[key] !== wrapped) namespace[key] = wrapped
    }
  }
  return namespace
}

/**
 * This is called for every package/internal-module that dd-trace supports instrumentation for
 * In practice, `modules` is always an array with a single entry.
 *
 * @overload
 * @param {string[]} modules list of modules to hook into
 * @param {object} hookOptions hook options
 * @param {Function} onrequire callback to be executed upon encountering module
 */
/**
 * @overload
 * @param {string[]} modules list of modules to hook into
 * @param {object} hookOptions hook options
 * @param {Function} onrequire callback to be executed upon encountering module
 */
function Hook (modules, hookOptions, onrequire) {
  // TODO: Rewrite this to use class syntax. The same should be done for ritm.
  if (!(this instanceof Hook)) return new Hook(modules, hookOptions, onrequire)

  if (typeof hookOptions === 'function') {
    onrequire = hookOptions
    hookOptions = {}
  }

  this._patched = Object.create(null)
  const patched = new WeakMap()

  /**
   * @param {object|Function|undefined} moduleExports
   * @param {string} moduleName
   * @param {string|undefined} moduleBaseDir
   * @param {string|undefined} moduleVersion
   * @param {boolean|undefined} isIitm
   */
  const safeHook = (moduleExports, moduleName, moduleBaseDir, moduleVersion, isIitm) => {
    const parts = [moduleBaseDir, moduleName].filter(Boolean)
    const filename = path.join(...parts)

    const defaultExport = isIitm && moduleExports.default
    let defaultExportAliases
    let defaultWrapResult

    const wrappedOnrequire = (moduleExports, ...args) => {
      if (this._patched[filename] && patched.has(moduleExports)) {
        return patched.get(moduleExports)
      }

      const result = onrequire(moduleExports, ...args)
      if (result && (typeof result === 'object' || typeof result === 'function')) {
        patched.set(moduleExports, result)
        patched.set(result, result)
      }

      return result
    }

    try {
      moduleVersion ||= getVersion(moduleBaseDir)
    } catch (error) {
      log.error('Error getting version for "%s": %s', moduleName, error.message, error)
      return moduleExports
    }

    if (
      defaultExport &&
      (typeof defaultExport === 'object' ||
      typeof defaultExport === 'function')
    ) {
      defaultWrapResult = wrappedOnrequire(defaultExport, moduleName, moduleBaseDir, moduleVersion, isIitm)
      if (defaultWrapResult && defaultWrapResult !== defaultExport) {
        defaultExportAliases = []
        for (const exportName of Object.keys(moduleExports)) {
          if (exportName !== 'default' && moduleExports[exportName] === defaultExport) {
            defaultExportAliases.push(exportName)
          }
        }
      }
    }

    // A builtin's named ESM exports are a second view of what `default` already points at, and
    // `patched` cannot relate them because it keys on the object the hook ran against.
    let newExports
    if (defaultWrapResult && isNodeBuiltinModuleName(moduleName)) {
      newExports = syncExports(moduleExports, defaultWrapResult)
    } else {
      newExports = wrappedOnrequire(moduleExports, moduleName, moduleBaseDir, moduleVersion, isIitm)
    }

    if (defaultWrapResult && defaultExportAliases) {
      newExports.default = defaultWrapResult
      for (const exportName of defaultExportAliases) {
        moduleExports[exportName] = defaultWrapResult
      }
    }

    this._patched[filename] = true

    return newExports
  }

  this._ritmHook = ritm(modules, {}, safeHook)
  /**
   * @param {Record<string, unknown>} moduleExports
   * @param {string} moduleName
   * @param {string | undefined} moduleBaseDir
   * @param {string | undefined} format
   */
  const onimport = (moduleExports, moduleName, moduleBaseDir, format) => {
    if (format === 'commonjs') {
      const wrapped = safeHook(moduleExports.default, moduleName, moduleBaseDir, undefined, false)
      return syncExports(moduleExports, wrapped)
    }
    return safeHook(moduleExports, moduleName, moduleBaseDir, null, true)
  }
  this._iitmHook = iitm(modules, hookOptions, onimport)
}

module.exports = Hook
