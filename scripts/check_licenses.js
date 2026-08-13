/* eslint-disable no-console */
'use strict'

const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const { parse: parseYarnLock } = require('@yarnpkg/lockfile')
const { parse: parseJsonc, printParseErrorCode } = require('jsonc-parser')

/**
 * @typedef {object} DependencyManifest
 * @property {string} [name]
 * @property {Record<string, string>} [dependencies]
 * @property {Record<string, string>} [optionalDependencies]
 * @property {Record<string, string>} [peerDependencies]
 * @property {string[]} [optionalPeers]
 * @property {boolean} [dev]
 * @property {boolean} [devOptional]
 * @property {boolean} [link]
 */

/**
 * @typedef {object} BunPackageContext
 * @property {string} packagePath
 * @property {BunPackageContext} [parent]
 */

/**
 * @typedef {object} DependencyPattern
 * @property {boolean} [allowMissing]
 * @property {BunPackageContext} [context]
 * @property {string} name
 * @property {string} range
 */

const rootDirectory = process.cwd()
const dependencies = getProductionDependencies(rootDirectory)
const licenses = new Set()

addCsvComponents(licenses, join(rootDirectory, 'LICENSE-3rdparty.csv'), true)

if (!checkLicenses(dependencies)) process.exitCode = 1

/**
 * @param {string} directory
 */
function getProductionDependencies (directory) {
  const packageJson = require(join(directory, 'package.json'))
  const dependencies = new Set([packageJson.name])
  const bunLockPath = join(directory, 'bun.lock')

  if (existsSync(bunLockPath)) {
    addBunProductionDependencies(dependencies, bunLockPath, packageJson)
  } else {
    addYarnProductionDependencies(dependencies, directory, packageJson)
  }
  addNpmProductionDependencies(dependencies, join(directory, 'vendor', 'package-lock.json'))

  const vendoredDependenciesPath = join(directory, '.github', 'vendored-dependencies.csv')
  if (existsSync(vendoredDependenciesPath)) addCsvComponents(dependencies, vendoredDependenciesPath, false)

  return dependencies
}

/**
 * @param {Set<string>} dependencies
 * @param {string} directory
 * @param {DependencyManifest} packageJson
 */
function addYarnProductionDependencies (dependencies, directory, packageJson) {
  const { object: lock, type } = parseYarnLock(readFileSync(join(directory, 'yarn.lock'), 'utf8'))
  if (type !== 'success') throw new Error(`Cannot parse yarn.lock: ${type}`)

  /** @type {DependencyPattern[]} */
  const patterns = []
  const visited = new Set()
  addDependencyPatterns(patterns, packageJson)

  for (let i = 0; i < patterns.length; i++) {
    const { name, range } = patterns[i]
    const pattern = `${name}@${range}`
    if (visited.has(pattern)) continue

    const dependency = lock[pattern]
    if (!dependency) throw new Error(`Missing yarn.lock entry for ${pattern}`)

    visited.add(pattern)
    dependencies.add(normalizeDependencyName(name, range))
    addDependencyPatterns(patterns, dependency)
  }
}

/**
 * @param {Set<string>} dependencies
 * @param {string} bunLockPath
 * @param {DependencyManifest} packageJson
 */
function addBunProductionDependencies (dependencies, bunLockPath, packageJson) {
  const parseErrors = []
  const lock = parseJsonc(readFileSync(bunLockPath, 'utf8'), parseErrors, { allowTrailingComma: true })
  if (parseErrors.length) {
    const { error, offset } = parseErrors[0]
    throw new Error(`Cannot parse bun.lock: ${printParseErrorCode(error)} at offset ${offset}`)
  }
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) {
    throw new Error('bun.lock does not contain an object')
  }

  const { lockfileVersion, packages, workspaces } = lock
  if (!Number.isInteger(lockfileVersion) || lockfileVersion < 0 || lockfileVersion > 2) {
    throw new Error(`Unsupported bun.lock version: ${lockfileVersion}`)
  }
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    throw new Error('bun.lock does not contain package metadata')
  }
  const rootWorkspace = workspaces?.['']
  if (!rootWorkspace || typeof rootWorkspace !== 'object' || Array.isArray(rootWorkspace)) {
    throw new Error('bun.lock does not contain a root workspace')
  }

  /** @type {DependencyPattern[]} */
  const patterns = []
  const visited = new Set()
  addDependencyPatterns(patterns, packageJson)

  for (let i = 0; i < patterns.length; i++) {
    const { allowMissing, context, name } = patterns[i]
    const packagePath = getBunPackagePath(packages, name, context)
    if (packagePath === undefined) {
      if (allowMissing) continue
      throw new Error(`Missing bun.lock entry for ${name}`)
    }
    if (visited.has(packagePath)) continue

    const entry = packages[packagePath]
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') {
      throw new TypeError(`Invalid bun.lock entry for ${packagePath}`)
    }

    visited.add(packagePath)
    const resolution = entry[0]
    const versionIndex = resolution.indexOf('@', resolution.startsWith('@') ? 1 : 0)
    if (versionIndex <= 0) throw new Error(`Invalid bun.lock resolution for ${packagePath}`)

    const packageName = resolution.slice(0, versionIndex)
    const source = resolution.slice(versionIndex + 1)
    const childContext = { packagePath, parent: context }
    if (source.startsWith('workspace:')) {
      const workspace = workspaces[source.slice('workspace:'.length)]
      if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
        throw new Error(`Missing bun.lock workspace for ${packagePath}`)
      }

      addDependencyPatterns(patterns, workspace, childContext, true)
      continue
    }

    if (!source.startsWith('link:')) dependencies.add(packageName)
    for (let entryIndex = 1; entryIndex < entry.length; entryIndex++) {
      const manifest = entry[entryIndex]
      if (typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest)) {
        addDependencyPatterns(patterns, manifest, childContext, true)
        break
      }
    }
  }
}

/**
 * @param {Record<string, unknown>} packages
 * @param {string} name
 * @param {BunPackageContext} [context]
 */
function getBunPackagePath (packages, name, context) {
  for (let current = context; current !== undefined; current = current.parent) {
    const packagePath = `${current.packagePath}/${name}`
    if (Object.hasOwn(packages, packagePath)) return packagePath
  }
  if (Object.hasOwn(packages, name)) return name
}

/**
 * @param {Set<string>} dependencies
 * @param {string} packageLockPath
 */
function addNpmProductionDependencies (dependencies, packageLockPath) {
  const { packages } = require(packageLockPath)
  if (!packages) throw new Error('package-lock.json does not contain package metadata')

  for (const [packagePath, dependency] of Object.entries(packages)) {
    // A peer dependency is supplied by the consumer, not shipped by this package, the same
    // way addYarnProductionDependencies excludes peerDependencies from its graph walk.
    if (!packagePath || dependency.link || dependency.peer || (dependency.dev && !dependency.devOptional)) continue

    dependencies.add(dependency.name ?? getNameFromPackagePath(packagePath))
  }
}

/**
 * @param {DependencyPattern[]} patterns
 * @param {DependencyManifest} manifest
 * @param {BunPackageContext} [context]
 * @param {boolean} [includePeers]
 */
function addDependencyPatterns (patterns, manifest, context, includePeers = false) {
  const optionalDependencies = manifest.optionalDependencies ?? {}

  if ((manifest.dependencies) != null) {
    for (const [name, range] of Object.entries(manifest.dependencies)) {
      if (!Object.hasOwn(optionalDependencies, name)) {
        addDependencyPattern(patterns, name, range, context)
      }
    }
  }
  for (const [name, range] of Object.entries(optionalDependencies)) {
    addDependencyPattern(patterns, name, range, context)
  }
  if (includePeers && (manifest.peerDependencies) != null) {
    for (const [name, range] of Object.entries(manifest.peerDependencies)) {
      addDependencyPattern(patterns, name, range, context, manifest.optionalPeers?.includes(name))
    }
  }
}

/**
 * @param {DependencyPattern[]} patterns
 * @param {string} name
 * @param {string} range
 * @param {BunPackageContext} [context]
 * @param {boolean} [allowMissing]
 */
function addDependencyPattern (patterns, name, range, context, allowMissing = false) {
  /** @type {DependencyPattern} */
  const pattern = { name, range }
  if (context !== undefined) pattern.context = context
  if (allowMissing) pattern.allowMissing = true
  patterns.push(pattern)
}

/**
 * @param {string} name
 * @param {string} range
 */
function normalizeDependencyName (name, range) {
  if (!range.startsWith('npm:')) return name

  const target = range.slice('npm:'.length)
  const versionIndex = target.lastIndexOf('@')
  return versionIndex > 0 ? target.slice(0, versionIndex) : target
}

/**
 * @param {string} packagePath
 */
function getNameFromPackagePath (packagePath) {
  const nodeModulesIndex = packagePath.lastIndexOf('node_modules/')
  if (nodeModulesIndex === -1) throw new Error(`Cannot determine package name from ${packagePath}`)

  return packagePath.slice(nodeModulesIndex + 'node_modules/'.length)
}

/**
 * @param {Set<string>} components
 * @param {string} filePath
 * @param {boolean} hasHeader
 */
function addCsvComponents (components, filePath, hasHeader) {
  const lines = readFileSync(filePath, 'utf8').split('\n')

  for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue

    components.add(lines[i].split(',', 1)[0].replaceAll(/^"|"$/g, ''))
  }
}

/**
 * @param {Set<string>} dependencies
 */
function checkLicenses (dependencies) {
  const missing = []
  const extraneous = []

  for (const dependency of dependencies) {
    if (!licenses.has(dependency)) {
      missing.push(dependency)
    }
  }

  for (const dependency of licenses) {
    if (!dependencies.has(dependency)) {
      extraneous.push(dependency)
    }
  }

  if (missing.length) {
    console.error(`Missing 3rd-party license for ${missing.join(', ')}.`)
  }

  if (extraneous.length) {
    console.error(`Extraneous 3rd-party license for ${extraneous.join(', ')}.`)
  }

  return missing.length === 0 && extraneous.length === 0
}
