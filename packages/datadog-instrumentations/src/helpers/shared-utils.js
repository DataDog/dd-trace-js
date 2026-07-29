'use strict'

const { builtinModules } = require('node:module')

/**
 * @param {string} moduleName
 */
function stripNodePrefix (moduleName) {
  return moduleName.startsWith('node:') ? moduleName.slice(5) : moduleName
}

const builtinModuleNames = new Set(builtinModules.map(stripNodePrefix))

/**
 * @param {string} moduleName
 */
function isNodeBuiltinModuleName (moduleName) {
  return builtinModuleNames.has(stripNodePrefix(moduleName))
}

/**
 * @param {string} moduleName
 */
function isBuiltinModuleName (moduleName) {
  return moduleName === 'electron' || isNodeBuiltinModuleName(moduleName)
}

/**
 * @param {string} moduleName
 */
function normalizeModuleName (moduleName) {
  const stripped = stripNodePrefix(moduleName)
  return builtinModuleNames.has(stripped) ? stripped : moduleName
}

/**
 * @param {string} moduleName
 */
function isRelativeRequire (moduleName) {
  return moduleName.startsWith('./') || moduleName.startsWith('../')
}

module.exports = {
  isBuiltinModuleName,
  isNodeBuiltinModuleName,
  isRelativeRequire,
  normalizeModuleName,
}
