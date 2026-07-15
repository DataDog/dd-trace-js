'use strict'

const { existsSync, readFileSync } = require('node:fs')

/**
 * @typedef {{ name: string, version: string }} LockedDependency
 */

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
  for (const [alias, spec] of Object.entries(dependencies ?? {})) {
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
  const lock = parseBunLock(readFileSync(lockPath, 'utf8'))
  const root = lock.workspaces?.['']
  if (!root) return []

  const dependencies = new Map()
  const visited = new Set()
  const queue = [
    ...Object.keys(root.dependencies ?? {}),
    ...Object.keys(root.optionalDependencies ?? {}),
  ]

  while (queue.length > 0) {
    const key = queue.pop()
    if (visited.has(key)) continue
    visited.add(key)

    const entry = lock.packages?.[key]
    if (!Array.isArray(entry)) continue

    const spec = entry[0]
    if (typeof spec === 'string') {
      const dependency = splitBunPackageSpec(spec)
      const dependencyKey = `${dependency.name}\0${dependency.version}`
      if (!dependencies.has(dependencyKey)) dependencies.set(dependencyKey, dependency)
    }

    const meta = entry[2]
    if (!meta || typeof meta !== 'object') continue

    for (const child of Object.keys(meta.dependencies ?? {})) {
      queue.push(resolveBunLockKey(lock, key, child))
    }
    for (const child of Object.keys(meta.optionalDependencies ?? {})) {
      queue.push(resolveBunLockKey(lock, key, child))
    }
  }

  return [...dependencies.values()].sort(compareDependencies)
}

/**
 * @param {string} content
 */
function parseBunLock (content) {
  return JSON.parse(content.replaceAll(/,(\s*[}\]])/g, '$1'))
}

/**
 * @param {string} spec
 * @returns {LockedDependency}
 */
function splitBunPackageSpec (spec) {
  const versionStart = spec.indexOf('@', spec.startsWith('@') ? spec.indexOf('/') + 1 : 1)
  return versionStart === -1
    ? { name: spec, version: '' }
    : { name: spec.slice(0, versionStart), version: spec.slice(versionStart + 1) }
}

/**
 * @param {{ packages: Record<string, unknown[]> }} lock
 * @param {string} parentKey
 * @param {string} childName
 */
function resolveBunLockKey (lock, parentKey, childName) {
  const nestedKey = `${parentKey}/${childName}`
  return lock.packages[nestedKey] ? nestedKey : childName
}

/**
 * @param {string} lockPath
 * @returns {LockedDependency[]}
 */
function listNpmLockDependencies (lockPath) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  const dependencies = []
  for (const [packagePath, entry] of Object.entries(lock.packages ?? {})) {
    if (!packagePath || entry.dev) continue

    dependencies.push({
      name: entry.name ?? packagePath.split('node_modules/').at(-1),
      version: entry.version ?? '',
    })
  }
  return dependencies.sort(compareDependencies)
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
  listNpmLockDependencies,
  readVendoredDependencyNames,
}
