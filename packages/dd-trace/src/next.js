'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

const GLOBAL_ROUTE = '/*'
const packageRoot = path.join(__dirname, '../../..')

/**
 * @typedef {object} PackageManifest
 * @property {string} name
 * @property {Record<string, string>} [dependencies]
 * @property {Record<string, string>} [optionalDependencies]
 * @property {Record<string, string>} [peerDependencies]
 * @property {Record<string, { optional?: boolean }>} [peerDependenciesMeta]
 */

/**
 * @typedef {Record<string, unknown> & {
 *   output?: string,
 *   outputFileTracingRoot?: string,
 *   outputFileTracingIncludes?: Record<string, string[]>,
 *   serverExternalPackages?: string[]
 * }} NextConfig
 */

/**
 * @param {string} packageJsonPath
 * @returns {PackageManifest}
 */
function readPackageManifest (packageJsonPath) {
  return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
}

/**
 * @param {string} packageName
 * @param {NodeJS.Require} packageRequire
 * @returns {string}
 */
function resolvePackageJson (packageName, packageRequire) {
  try {
    return packageRequire.resolve(`${packageName}/package.json`)
  } catch (error) {
    if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      throw error
    }
  }

  let directory = path.dirname(packageRequire.resolve(packageName))

  while (directory !== path.dirname(directory)) {
    const packageJsonPath = path.join(directory, 'package.json')

    if (fs.existsSync(packageJsonPath)) {
      return packageJsonPath
    }

    directory = path.dirname(directory)
  }

  throw new Error(`Could not resolve the package manifest for '${packageName}'.`)
}

/**
 * @param {string} packageName
 * @param {NodeJS.Require} packageRequire
 * @returns {string|undefined}
 */
function resolveOptionalPackageJson (packageName, packageRequire) {
  try {
    return resolvePackageJson(packageName, packageRequire)
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') {
      throw error
    }
  }
}

/**
 * @param {string} packageJsonPath
 * @param {Set<string>} packageJsonPaths
 */
function collectOptionalPackageJsonPath (packageJsonPath, packageJsonPaths) {
  const { peerDependencies, peerDependenciesMeta } = readPackageManifest(packageJsonPath)
  const packageRequire = createRequire(packageJsonPath)

  for (const peerName of Object.keys(peerDependencies ?? {})) {
    const peerPackageJsonPath = resolveOptionalPackageJson(peerName, packageRequire)
    if (peerPackageJsonPath === undefined) {
      if (!peerDependenciesMeta?.[peerName]?.optional) return
    } else {
      collectPackageJsonPaths(peerPackageJsonPath, packageJsonPaths)
    }
  }

  collectPackageJsonPaths(packageJsonPath, packageJsonPaths)
}

/**
 * @param {string} packageJsonPath
 * @param {Set<string>} packageJsonPaths
 */
function collectPackageJsonPaths (packageJsonPath, packageJsonPaths) {
  if (packageJsonPaths.has(packageJsonPath)) return

  packageJsonPaths.add(packageJsonPath)

  const { dependencies, optionalDependencies } = readPackageManifest(packageJsonPath)
  const packageRequire = createRequire(packageJsonPath)

  for (const dependencyName of Object.keys(dependencies ?? {})) {
    collectPackageJsonPaths(resolvePackageJson(dependencyName, packageRequire), packageJsonPaths)
  }

  for (const dependencyName of Object.keys(optionalDependencies ?? {})) {
    const dependencyPackageJsonPath = resolveOptionalPackageJson(dependencyName, packageRequire)
    if (dependencyPackageJsonPath !== undefined) {
      collectOptionalPackageJsonPath(dependencyPackageJsonPath, packageJsonPaths)
    }
  }
}

/**
 * @param {string[]} existingValues
 * @param {Iterable<string>} additionalValues
 * @returns {string[]}
 */
function appendUnique (existingValues, additionalValues) {
  const result = [...existingValues]
  const seen = new Set(result)

  for (const value of additionalValues) {
    if (!seen.has(value)) {
      seen.add(value)
      result.push(value)
    }
  }

  return result
}

/**
 * @param {string} parentPath
 * @param {string} childPath
 * @returns {boolean}
 */
function containsPath (parentPath, childPath) {
  const relativePath = path.relative(parentPath, childPath)
  return relativePath === '' || (!relativePath.startsWith(`..${path.sep}`) &&
    relativePath !== '..' &&
    !path.isAbsolute(relativePath))
}

/**
 * @param {NextConfig} config
 * @param {{ projectRoot?: string }} options
 * @returns {NextConfig}
 */
function withDatadogConfig (config = {}, options = {}) {
  const serverExternalPackages = appendUnique(config.serverExternalPackages ?? [], ['dd-trace'])

  if (config.output !== 'standalone') {
    return {
      ...config,
      serverExternalPackages,
    }
  }

  const packageJsonPaths = new Set()
  collectPackageJsonPaths(path.join(packageRoot, 'package.json'), packageJsonPaths)

  const packageGlobs = []
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd())
  const outputFileTracingRoot = path.resolve(projectRoot, config.outputFileTracingRoot ?? '.')
  for (const packageJsonPath of packageJsonPaths) {
    const dependencyRoot = path.dirname(packageJsonPath)
    if (!containsPath(outputFileTracingRoot, dependencyRoot)) {
      const { name } = readPackageManifest(packageJsonPath)
      throw new Error(
        `'${name}' resolves outside outputFileTracingRoot. ` +
        'Set outputFileTracingRoot to a common parent of the Next.js app and its dependencies.'
      )
    }

    const relativeDependencyRoot = path.relative(projectRoot, dependencyRoot).replaceAll(path.sep, '/') || '.'
    packageGlobs.push(`${relativeDependencyRoot}/**/*`)
  }

  const outputFileTracingIncludes = config.outputFileTracingIncludes ?? {}

  return {
    ...config,
    outputFileTracingIncludes: {
      ...outputFileTracingIncludes,
      [GLOBAL_ROUTE]: appendUnique(outputFileTracingIncludes[GLOBAL_ROUTE] ?? [], packageGlobs),
    },
    serverExternalPackages,
  }
}

module.exports = withDatadogConfig
