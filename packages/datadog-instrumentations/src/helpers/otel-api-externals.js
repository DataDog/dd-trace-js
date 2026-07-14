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

  for (const [name, versionRange] of OTEL_API_VERSION_RANGES) {
    const manifestDirectory = declared.get(name)
    if (!manifestDirectory) continue

    try {
      const entry = createRequire(path.join(manifestDirectory, 'package.json')).resolve(name)
      const { pkgJson } = extractPackageAndModulePath(entry.replaceAll('\\', '/'))
      const { version } = JSON.parse(fs.readFileSync(pkgJson, 'utf8'))
      if (!satisfies(version, versionRange)) continue
      packages.set(name, { moduleBaseDir: path.dirname(pkgJson).replaceAll('\\', '/') })
    } catch {
      // A declaration without a supported installed package cannot provide the runtime copy.
    }
  }
  return packages
}

/**
 * @param {string} workingDirectory
 * @returns {(directory?: string) => Map<string, OtelApiPackage>}
 */
function createApplicationOtelApiPackageResolver (workingDirectory) {
  const rootDirectory = path.resolve(workingDirectory)
  const rootPackages = getApplicationOtelApiPackages(rootDirectory)
  const cache = new Map([[rootDirectory, rootPackages]])

  /**
   * @param {string} [directory]
   * @returns {Map<string, OtelApiPackage>}
   */
  return function resolveApplicationOtelApiPackages (directory) {
    if (!directory) return rootPackages

    const resolvedDirectory = path.resolve(directory)
    const relativeDirectory = path.relative(rootDirectory, resolvedDirectory)
    if (
      relativeDirectory === '..' ||
      relativeDirectory.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeDirectory)
    ) {
      return rootPackages
    }
    if (resolvedDirectory.replaceAll('\\', '/').includes('/node_modules/')) return rootPackages

    let packages = cache.get(resolvedDirectory)
    if (!packages) {
      packages = getApplicationOtelApiPackages(resolvedDirectory)
      cache.set(resolvedDirectory, packages)
    }
    return packages
  }
}

/**
 * @param {string} workingDirectory
 * @returns {Map<string, string>}
 */
function readDeclaredDependencies (workingDirectory) {
  const declared = new Map()
  let directory = path.resolve(workingDirectory)
  const { root } = path.parse(directory)

  while (true) {
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
          if (!declared.has(name)) declared.set(name, directory)
        }
      }
    } catch {
      // Keep looking for a workspace manifest in an ancestor directory.
    }
    if (directory === root) break
    directory = path.dirname(directory)
  }
  return declared
}

module.exports = {
  createApplicationOtelApiPackageResolver,
  getApplicationOtelApiPackages,
}
