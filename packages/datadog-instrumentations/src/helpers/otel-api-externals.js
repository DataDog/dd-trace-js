'use strict'

const fs = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')

const satisfies = require('../../../../vendor/dist/semifies')
const {
  API_LOGS_VERSION_RANGE,
  API_VERSION_RANGE,
} = require('../../../dd-trace/src/opentelemetry/api')
const extractPackageAndModulePath = require('./extract-package-and-module-path')

const OTEL_API_VERSION_RANGES = new Map([
  ['@opentelemetry/api', API_VERSION_RANGE],
  ['@opentelemetry/api-logs', API_LOGS_VERSION_RANGE],
])

/**
 * @typedef {object} OtelApiPackage
 * @property {string} moduleBaseDir
 */

/**
 * @param {string} workingDirectory
 * @returns {Map<string, OtelApiPackage>}
 */
function getApplicationOtelApiPackages (workingDirectory) {
  const declared = readDeclaredDependencies(workingDirectory)
  const packages = new Map()
  if (declared.size === 0) return packages

  const requireFromApplication = createRequire(path.join(workingDirectory, 'package.json'))
  for (const [name, versionRange] of OTEL_API_VERSION_RANGES) {
    if (!declared.has(name)) continue

    try {
      const entry = requireFromApplication.resolve(name)
      const { pkgJson } = extractPackageAndModulePath(entry)
      const { version } = JSON.parse(fs.readFileSync(pkgJson, 'utf8'))
      if (!satisfies(version, versionRange)) continue
      packages.set(name, { moduleBaseDir: path.dirname(pkgJson) })
    } catch {
      // A declaration without a supported installed package cannot provide the runtime copy.
    }
  }
  return packages
}

/**
 * @param {string} workingDirectory
 * @returns {Set<string>}
 */
function readDeclaredDependencies (workingDirectory) {
  const declared = new Set()
  let directory = path.resolve(workingDirectory)
  const { root } = path.parse(directory)

  while (directory !== root) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
      for (const dependencies of [
        manifest.dependencies,
        manifest.devDependencies,
        manifest.optionalDependencies,
        manifest.peerDependencies,
      ]) {
        if (!dependencies) continue
        for (const name of Object.keys(dependencies)) {
          declared.add(name)
        }
      }
    } catch {
      // Keep looking for a workspace manifest in an ancestor directory.
    }
    directory = path.dirname(directory)
  }
  return declared
}

module.exports = { getApplicationOtelApiPackages }
