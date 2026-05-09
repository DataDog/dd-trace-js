/* eslint-disable no-console */
'use strict'

const { createReadStream, existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const readline = require('node:readline')
const { name: rootPackageName } = require('../package.json')

const filePath = join(__dirname, '..', 'LICENSE-3rdparty.csv')
const aliasMap = getAliasMap()
const deps = getProdDeps()
const licenses = new Set()
let isHeader = true

const lineReader = readline.createInterface({
  input: createReadStream(filePath),
})

lineReader.on('line', line => {
  if (isHeader) {
    isHeader = false
    return
  }

  const trimmed = line.trim()
  if (!trimmed) return // Skip empty lines
  const columns = line.split(',')
  const component = columns[0]

  // Strip quotes from the component name
  licenses.add(component.replaceAll(/^"|"$/g, ''))
})

lineReader.on('close', () => {
  if (!checkLicenses(deps)) {
    process.exit(1)
  }
})

function getProdDeps () {
  // Both lockfiles list the union of installed packages across platforms, so the CSV stays
  // valid on any host. `npm ls --omit=dev --json --all` would only list the optionals
  // installed on the current platform and skew on Darwin/arm64 vs Linux/x64.
  const deps = new Set([normalizeDepName(rootPackageName)])

  addBunLockProdDeps(deps, join(__dirname, '..', 'bun.lock'))
  addNpmLockProdDeps(deps, join(__dirname, '..', 'vendor', 'package-lock.json'))
  addVendoredDeps(deps)

  return deps
}

/**
 * @param {Set<string>} deps
 * @param {string} lockPath Absolute path to a `bun.lock` file.
 */
function addBunLockProdDeps (deps, lockPath) {
  const lock = parseBunLock(readFileSync(lockPath, 'utf8'))
  const root = lock.workspaces?.['']
  if (!root) return

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
      const versionStart = spec.lastIndexOf('@')
      deps.add(normalizeDepName(versionStart > 0 ? spec.slice(0, versionStart) : spec))
    }

    const meta = entry[2]
    if (!meta || typeof meta !== 'object') continue

    for (const transitiveName of Object.keys(meta.dependencies ?? {})) {
      queue.push(resolveBunLockKey(lock, key, transitiveName))
    }
    for (const transitiveName of Object.keys(meta.optionalDependencies ?? {})) {
      queue.push(resolveBunLockKey(lock, key, transitiveName))
    }
  }
}

/**
 * Pick the version installed under the parent's context (`A/B/foo`) over the top-level
 * (`foo`), matching how bun resolves transitive deps with conflicting versions.
 *
 * @param {{ packages: Record<string, unknown[]> }} lock
 * @param {string} parentKey
 * @param {string} childName
 */
function resolveBunLockKey (lock, parentKey, childName) {
  const nestedKey = `${parentKey}/${childName}`
  return lock.packages[nestedKey] ? nestedKey : childName
}

/**
 * bun.lock is JSONC — JSON with structural trailing commas before `}`/`]`. Strip them
 * and JSON.parse. Quoted values in this file never end in `,]` or `,}`, so the regex is safe.
 *
 * @param {string} content
 */
function parseBunLock (content) {
  return JSON.parse(content.replaceAll(/,(\s*[}\]])/g, '$1'))
}

/**
 * @param {Set<string>} deps
 * @param {string} lockPath Absolute path to a v3 npm `package-lock.json` file.
 */
function addNpmLockProdDeps (deps, lockPath) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  for (const [packagePath, entry] of Object.entries(lock.packages ?? {})) {
    if (!packagePath || entry.dev) continue

    // Aliased entries (e.g. `@datadog/source-map` → `source-map`) expose the upstream name
    // via `entry.name`; otherwise the leaf segment after the last `node_modules/` is the
    // package name, including its scope (`node_modules/@scope/foo` → `@scope/foo`).
    deps.add(normalizeDepName(entry.name ?? packagePath.split('node_modules/').at(-1)))
  }
}

function addVendoredDeps (deps) {
  const vendoredDepsPath = join(__dirname, '..', '.github', 'vendored-dependencies.csv')

  // If the vendored dependencies file doesn't exist, skip
  if (!existsSync(vendoredDepsPath)) {
    return
  }

  const content = readFileSync(vendoredDepsPath, 'utf8')

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue // Skip empty lines

    const columns = line.split(',')
    const component = columns[0]

    // Strip quotes from the component name and add to deps
    deps.add(normalizeDepName(component.replaceAll(/^"|"$/g, '')))
  }
}

function getAliasMap () {
  const rootPackagePath = join(__dirname, '..', 'package.json')
  const vendorPackagePath = join(__dirname, '..', 'vendor', 'package.json')
  const map = new Map()

  collectAliasesFromPackageJson(rootPackagePath, map)
  collectAliasesFromPackageJson(vendorPackagePath, map)

  return map
}

function collectAliasesFromPackageJson (packagePath, map) {
  if (!existsSync(packagePath)) return

  const packageJson = require(packagePath)
  const deps = packageJson?.dependencies ?? {}
  const optionalDeps = packageJson?.optionalDependencies ?? {}

  collectAliasesFromDeps(deps, map)
  collectAliasesFromDeps(optionalDeps, map)
}

function collectAliasesFromDeps (deps, map) {
  for (const [alias, spec] of Object.entries(deps)) {
    if (typeof spec !== 'string' || !spec.startsWith('npm:')) continue

    const rawTarget = spec.slice('npm:'.length)
    const atIndex = rawTarget.lastIndexOf('@')
    const target = atIndex > 0 ? rawTarget.slice(0, atIndex) : rawTarget

    if (target) {
      map.set(alias, target)
    }
  }
}

function normalizeDepName (name) {
  return aliasMap.get(name) ?? name
}

function checkLicenses (typeDeps) {
  const missing = []
  const extraneous = []

  for (const dep of typeDeps) {
    if (!licenses.has(dep)) {
      missing.push(dep)
    }
  }

  for (const dep of licenses) {
    if (!typeDeps.has(dep)) {
      extraneous.push(dep)
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
