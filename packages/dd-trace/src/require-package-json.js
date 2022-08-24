'use strict'

const path = require('path')
const fs = require('fs')

/**
 * Given a package name and a module to start from, find a package's
 * package.json file, parses it, and returns the result.
 *
 * Equivalent to require(`${name}/package.json`) prior to Node 12.
 *
 * @typedef { import('module').Module } Module
 * @param {string} name
 * @param {Module} module
 * @return {Object} The parsed package.json
 */
function requirePackageJson (name, module) {
  if (path.isAbsolute(name)) {
    const candidate = path.join(name, 'package.json')
    return JSON.parse(fs.readFileSync(candidate, 'utf8'))
  }
  for (const modulePath of module.paths) {
    const candidate = path.join(modulePath, name, 'package.json')
    try {
      return JSON.parse(fs.readFileSync(candidate, 'utf8'))
    } catch (e) {
      continue
    }
  }
  throw new Error(`could not find ${name}/package.json`)
}

/**
 * Given a package name and a module to start from, find a package's
 * package.json file, parses it, and returns the version on it.
 *
 * Equivalent to require(`${name}/package.json`).version prior to Node 12.
 *
 * @typedef { import('module').Module } Module
 * @param {string} name
 * @param {Module} module
 * @return {string} Version in the parsed package.json
 */
function requirePackageVersion (name, module) {
  const pkg = requirePackageJson(name, module)
  return pkg && pkg.version
}

module.exports = { requirePackageJson, requirePackageVersion }
