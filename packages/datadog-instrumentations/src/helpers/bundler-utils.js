'use strict'

const fs = require('node:fs')
const path = require('node:path')

/**
 * Determines if a file is a ESM module or CommonJS
 *
 * @param {string} fullPathToModule File to analyze
 * @param {string} [modulePackageJsonPath] Path of the package.json
 * @param {object} [packageJson] The content of the module package.json
 */
function isESMFile (fullPathToModule, modulePackageJsonPath, packageJson = {}) {
  if (fullPathToModule.endsWith('.mjs') || fullPathToModule.endsWith('.mts')) return true
  if (fullPathToModule.endsWith('.cjs') || fullPathToModule.endsWith('.cts')) return false

  const pathParts = fullPathToModule.split(path.sep)
  do {
    pathParts.pop()

    const packageJsonPath = [...pathParts, 'package.json'].join(path.sep)
    if (packageJsonPath === modulePackageJsonPath) {
      return packageJson.type === 'module'
    }

    try {
      const packageJsonContent = fs.readFileSync(packageJsonPath).toString()
      const packageJson = JSON.parse(packageJsonContent)
      return packageJson.type === 'module'
    } catch {
      // file does not exit, continue
    }
  } while (pathParts.length > 0)

  return packageJson.type === 'module'
}

module.exports = { isESMFile }
