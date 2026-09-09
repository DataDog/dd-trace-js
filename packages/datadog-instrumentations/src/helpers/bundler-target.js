'use strict'

const { getNodeModuleFormat, getPackageDetails } = require('import-in-the-middle/bundler')

const instrumentations = require('./instrumentations')
const { matchesInstrumentation } = require('./instrumentation-utils')
const hooks = require('./hooks')
const { isNodeBuiltinModuleName, normalizeModuleName } = require('./shared-utils')

const loadedHooks = new Set()

/**
 * @typedef {object} BundlerTarget
 * @property {string|undefined} format
 * @property {string} moduleName
 * @property {string} package
 * @property {string} path
 * @property {string} url
 * @property {string|undefined} version
 */

/**
 * @param {string} specifier
 * @param {string} url
 * @returns {BundlerTarget|undefined}
 */
function getBundlerTarget (specifier, url) {
  if (isNodeBuiltinModuleName(specifier)) {
    const moduleName = normalizeModuleName(specifier)
    loadPackageHook(moduleName)
    if (!matchesAnyInstrumentation(moduleName, undefined, moduleName)) return

    return {
      format: 'builtin',
      moduleName: specifier,
      package: moduleName,
      path: '',
      url: specifier,
      version: undefined,
    }
  }

  const details = getPackageDetails(url)
  if (details === undefined) return

  const moduleName = isPackageRootSpecifier(specifier)
    ? details.name
    : `${details.name}/${details.path}`
  return createBundlerTarget(details, moduleName, url)
}

/**
 * Matches a resolved file without relying on its import specifier.
 *
 * @param {string} url
 * @returns {BundlerTarget|undefined}
 */
function getBundlerTargetByPath (url) {
  const details = getPackageDetails(url)
  if (details === undefined) return
  return createBundlerTarget(details, `${details.name}/${details.path}`, url)
}

/**
 * @param {import('import-in-the-middle/bundler').PackageDetails} details
 * @param {string} moduleName
 * @param {string} url
 * @returns {BundlerTarget|undefined}
 */
function createBundlerTarget (details, moduleName, url) {
  loadPackageHook(details.name)
  if (!matchesAnyInstrumentation(details.name, details.version, moduleName)) return

  return {
    format: getNodeModuleFormat(url, details.packageJsonUrl, details.type),
    moduleName,
    package: details.name,
    path: details.path,
    url,
    version: details.version,
  }
}

/**
 * @param {string} specifier
 * @returns {boolean}
 */
function isPackageOfInterest (specifier) {
  const name = getPackageName(specifier)
  return name !== undefined && Object.hasOwn(hooks, name)
}

/**
 * @param {string} name
 */
function loadPackageHook (name) {
  if (loadedHooks.has(name)) return

  const hook = hooks[name]
  const load = hook?.fn ?? hook
  if (typeof load !== 'function') return

  load()
  loadedHooks.add(name)
}

/**
 * @param {string} name
 * @param {string|undefined} version
 * @param {string} moduleName
 * @returns {boolean}
 */
function matchesAnyInstrumentation (name, version, moduleName) {
  const entries = instrumentations[name]
  if (entries === undefined) return false

  for (const entry of entries) {
    if (matchesInstrumentation(name, version, moduleName, entry)) return true
  }
  return false
}

/**
 * @param {string} specifier
 * @returns {boolean}
 */
function isPackageRootSpecifier (specifier) {
  const name = getPackageName(specifier)
  return name !== undefined && name === specifier
}

/**
 * @param {string} specifier
 * @returns {string|undefined}
 */
function getPackageName (specifier) {
  if (isNodeBuiltinModuleName(specifier)) return normalizeModuleName(specifier)
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:')) return

  const firstSlash = specifier.indexOf('/')
  if (!specifier.startsWith('@')) return firstSlash === -1 ? specifier : specifier.slice(0, firstSlash)
  if (firstSlash === -1) return

  const secondSlash = specifier.indexOf('/', firstSlash + 1)
  return secondSlash === -1 ? specifier : specifier.slice(0, secondSlash)
}

module.exports = {
  getBundlerTarget,
  getBundlerTargetByPath,
  isPackageOfInterest,
}
