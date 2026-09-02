'use strict'

const { existsSync, readFileSync } = require('node:fs')

const { parse: parseJsonc, printParseErrorCode } = require('jsonc-parser')

/**
 * @typedef {{ name: string, version: string }} LockedDependency
 */

/**
 * @typedef {object} LockManifest
 * @property {Record<string, string>} [dependencies]
 * @property {Record<string, string>} [optionalDependencies]
 * @property {string[]} [optionalPeers]
 * @property {Record<string, string>} [peerDependencies]
 */

/**
 * @typedef {object} LockContext
 * @property {string} packagePath
 * @property {LockContext} [parent]
 */

/**
 * @typedef {object} DependencyPattern
 * @property {boolean} [allowMissing]
 * @property {LockContext} [context]
 * @property {string} name
 */

/**
 * @typedef {object} BunLock
 * @property {number} lockfileVersion
 * @property {Record<string, unknown[]>} packages
 * @property {Record<string, LockManifest>} workspaces
 */

const supportedLockfileVersion = 1

/**
 * @param {string[]} packagePaths
 * @returns {Map<string, string>}
 */
function collectAliasMap (packagePaths) {
  const aliases = new Map()
  for (const packagePath of packagePaths) {
    if (!existsSync(packagePath)) continue

    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
    collectAliasesFromDependencies(packageJson.dependencies, aliases)
    collectAliasesFromDependencies(packageJson.optionalDependencies, aliases)
  }
  return aliases
}

/**
 * @param {Record<string, string> | undefined} dependencies
 * @param {Map<string, string>} aliases
 */
function collectAliasesFromDependencies (dependencies, aliases) {
  if (!dependencies) return
  for (const [alias, spec] of Object.entries(dependencies)) {
    if (typeof spec !== 'string' || !spec.startsWith('npm:')) continue

    const rawTarget = spec.slice('npm:'.length)
    const versionStart = rawTarget.lastIndexOf('@')
    const target = versionStart > 0 ? rawTarget.slice(0, versionStart) : rawTarget
    if (target) aliases.set(alias, target)
  }
}

/**
 * @param {string} lockPath
 * @returns {LockedDependency[]}
 */
function listBunLockDependencies (lockPath) {
  const lock = parseBunLock(lockPath)
  const root = lock.workspaces['']
  if (!isObject(root)) throw new Error(`${lockPath} does not contain a root workspace`)

  const dependencies = new Map()
  const visited = new Set()
  /** @type {DependencyPattern[]} */
  const patterns = []
  addDependencyPatterns(patterns, root)

  for (let i = 0; i < patterns.length; i++) {
    const { allowMissing, context, name } = patterns[i]
    const packagePath = resolveBunLockKey(lock.packages, name, context)
    if (packagePath === undefined) {
      if (allowMissing) continue
      throw new Error(`Missing ${lockPath} entry for ${name}`)
    }
    if (visited.has(packagePath)) continue

    const entry = lock.packages[packagePath]
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') {
      throw new TypeError(`Invalid ${lockPath} entry for ${packagePath}`)
    }
    visited.add(packagePath)

    const dependency = splitBunPackageSpec(entry[0])
    const childContext = { packagePath, parent: context }
    if (dependency.version.startsWith('workspace:')) {
      const workspace = lock.workspaces[dependency.version.slice('workspace:'.length)]
      if (!isObject(workspace)) throw new Error(`Missing ${lockPath} workspace for ${packagePath}`)
      addDependencyPatterns(patterns, workspace, childContext, true)
      continue
    }

    if (!dependency.version.startsWith('link:')) {
      const dependencyKey = `${dependency.name}\0${dependency.version}`
      if (!dependencies.has(dependencyKey)) dependencies.set(dependencyKey, dependency)
    }

    addDependencyPatterns(patterns, findEntryManifest(entry), childContext, true)
  }

  return [...dependencies.values()].sort(compareDependencies)
}

/**
 * @param {DependencyPattern[]} patterns
 * @param {LockManifest | undefined} manifest
 * @param {LockContext} [context]
 * @param {boolean} [includePeers]
 */
function addDependencyPatterns (patterns, manifest, context, includePeers = false) {
  if (manifest === undefined) return

  if (manifest.dependencies) {
    for (const name of Object.keys(manifest.dependencies)) patterns.push({ name, context })
  }
  if (manifest.optionalDependencies) {
    for (const name of Object.keys(manifest.optionalDependencies)) patterns.push({ name, context })
  }
  if (!includePeers) return

  if (!manifest.peerDependencies) return
  for (const name of Object.keys(manifest.peerDependencies)) {
    const pattern = { name, context }
    if (manifest.optionalPeers?.includes(name)) pattern.allowMissing = true
    patterns.push(pattern)
  }
}

/**
 * @param {unknown[]} entry
 * @returns {LockManifest | undefined}
 */
function findEntryManifest (entry) {
  for (let i = 1; i < entry.length; i++) {
    if (isObject(entry[i])) return /** @type {LockManifest} */ (entry[i])
  }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isObject (value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {string} lockPath
 * @returns {BunLock}
 */
function parseBunLock (lockPath) {
  /** @type {import('jsonc-parser').ParseError[]} */
  const errors = []
  const lock = parseJsonc(readFileSync(lockPath, 'utf8'), errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    const { error, offset } = errors[0]
    throw new Error(`Cannot parse ${lockPath}: ${printParseErrorCode(error)} at offset ${offset}`)
  }
  if (!isObject(lock)) throw new Error(`${lockPath} does not contain an object`)
  if (lock.lockfileVersion !== supportedLockfileVersion) {
    throw new Error(`Unsupported lockfile version in ${lockPath}: ${lock.lockfileVersion}`)
  }
  if (!isObject(lock.packages)) throw new Error(`${lockPath} does not contain package metadata`)
  if (!isObject(lock.workspaces)) throw new Error(`${lockPath} does not contain workspace metadata`)
  return /** @type {BunLock} */ (lock)
}

/**
 * @param {string} spec
 * @returns {LockedDependency}
 */
function splitBunPackageSpec (spec) {
  const versionStart = spec.indexOf('@', spec.startsWith('@') ? spec.indexOf('/') + 1 : 1)
  if (versionStart <= 0 || versionStart === spec.length - 1) {
    throw new Error(`Invalid Bun package resolution: ${spec}`)
  }
  return { name: spec.slice(0, versionStart), version: spec.slice(versionStart + 1) }
}

/**
 * @param {Record<string, unknown[]>} packages
 * @param {string} name
 * @param {LockContext} [context]
 * @returns {string | undefined}
 */
function resolveBunLockKey (packages, name, context) {
  for (let current = context; current !== undefined; current = current.parent) {
    const packagePath = `${current.packagePath}/${name}`
    if (Object.hasOwn(packages, packagePath)) return packagePath
  }
  if (Object.hasOwn(packages, name)) return name
}

/**
 * @param {LockedDependency} left
 * @param {LockedDependency} right
 */
function compareDependencies (left, right) {
  const nameOrder = left.name.localeCompare(right.name)
  return nameOrder || left.version.localeCompare(right.version)
}

/**
 * @param {string} csvPath
 * @returns {string[]}
 */
function readVendoredDependencyNames (csvPath) {
  if (!existsSync(csvPath)) return []

  const dependencies = []
  for (const line of readFileSync(csvPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    dependencies.push(line.split(',')[0].replaceAll(/^"|"$/g, ''))
  }
  return dependencies
}

module.exports = {
  collectAliasMap,
  listBunLockDependencies,
  readVendoredDependencyNames,
}
