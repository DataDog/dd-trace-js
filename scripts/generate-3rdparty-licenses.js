#!/usr/bin/env node

/* eslint-disable no-console */
'use strict'

// Regenerate `LICENSE-3rdparty.csv` from the locks the project currently ships:
// `bun.lock` for runtime + optional root deps, `vendor/package-lock.json` for the
// vendored npm subtree, and `.github/vendored-dependencies.csv` for the vendor
// entries we ship verbatim. The output matches the format the previous
// `dd-license-attribution` CSV produced (`component,origin,license,copyright`,
// values in Python-list strings) so reviewers see only meaningful diffs when
// the dep tree changes.
//
// Usage:
//   node scripts/generate-3rdparty-licenses.js --check   # exit 1 if CSV drifted
//   node scripts/generate-3rdparty-licenses.js           # rewrite CSV in place

const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { request } = require('node:https')

const repoRoot = join(__dirname, '..')
const csvPath = join(repoRoot, 'LICENSE-3rdparty.csv')
const bunLockPath = join(repoRoot, 'bun.lock')
const vendorLockPath = join(repoRoot, 'vendor', 'package-lock.json')
const vendoredCsvPath = join(repoRoot, '.github', 'vendored-dependencies.csv')
const rootPackageJson = require('../package.json')
const aliasMap = collectAliasMap()
const REGISTRY = 'https://registry.npmjs.org'
const FETCH_CONCURRENCY = 16

run().catch(error => {
  console.error(error)
  process.exit(1)
})

async function run () {
  const wanted = collectWantedComponents()
  const previous = parseCsv(readFileSync(csvPath, 'utf8'))
  const augmented = await fillMissingMetadata(wanted, previous)
  const next = formatCsv(augmented)

  const check = process.argv.includes('--check')
  if (check) {
    const current = readFileSync(csvPath, 'utf8')
    if (current !== next) {
      console.error('LICENSE-3rdparty.csv is out of date. Run `node scripts/generate-3rdparty-licenses.js` and commit.')
      process.exit(1)
    }
    return
  }
  writeFileSync(csvPath, next)
  console.log(`Wrote ${next.split('\n').length - 2} entries to ${csvPath}.`)
}

/**
 * Walk `bun.lock` (root + transitives, regular and optional) and the vendor
 * `package-lock.json` and return a map of `<component> -> { name, version }`,
 * normalized via `npm:` aliases declared in `package.json` so e.g. an aliased
 * `@datadog/source-map -> source-map` is recorded under the upstream name.
 *
 * @returns {Map<string, { name: string, version: string }>}
 */
function collectWantedComponents () {
  // The previous generator (`dd-license-attribution`) recorded the project
  // itself as a row keyed by the root `package.json`'s `name`. Seed the map
  // with that self-row so the CSV diff stays narrow.
  const wanted = new Map([
    [rootPackageJson.name, { name: rootPackageJson.name, version: rootPackageJson.version, isRoot: true }],
  ])

  addBunLockComponents(wanted)
  addNpmLockComponents(wanted)

  for (const dep of readVendoredCsv()) wanted.set(dep, { name: dep })

  return wanted
}

/**
 * @param {Map<string, { name: string, version?: string }>} wanted
 */
function addBunLockComponents (wanted) {
  const lock = parseBunLock(readFileSync(bunLockPath, 'utf8'))
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
      const name = versionStart > 0 ? spec.slice(0, versionStart) : spec
      const version = versionStart > 0 ? spec.slice(versionStart + 1) : ''
      const normalized = aliasMap.get(name) ?? name
      const existing = wanted.get(normalized)
      if (!existing || !existing.version) wanted.set(normalized, { name: normalized, version })
    }

    const meta = entry[2]
    if (!meta || typeof meta !== 'object') continue

    for (const child of Object.keys(meta.dependencies ?? {})) queue.push(resolveBunLockKey(lock, key, child))
    for (const child of Object.keys(meta.optionalDependencies ?? {})) queue.push(resolveBunLockKey(lock, key, child))
  }
}

/**
 * @param {Map<string, { name: string, version?: string }>} wanted
 */
function addNpmLockComponents (wanted) {
  const lock = JSON.parse(readFileSync(vendorLockPath, 'utf8'))
  for (const [packagePath, entry] of Object.entries(lock.packages ?? {})) {
    if (!packagePath || entry.dev) continue
    const inferred = entry.name ?? packagePath.split('node_modules/').at(-1)
    const normalized = aliasMap.get(inferred) ?? inferred
    const existing = wanted.get(normalized)
    if (!existing || !existing.version) wanted.set(normalized, { name: normalized, version: entry.version ?? '' })
  }
}

function readVendoredCsv () {
  if (!existsSync(vendoredCsvPath)) return []
  const out = []
  for (const line of readFileSync(vendoredCsvPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const component = line.split(',')[0].replaceAll(/^"|"$/g, '')
    out.push(component)
  }
  return out
}

/**
 * `bun.lock` is JSONC — JSON with structural trailing commas before `}`/`]`. Strip them
 * and `JSON.parse`. Quoted values in this file never end in `,]` or `,}`, so the regex is safe.
 *
 * @param {string} content
 */
function parseBunLock (content) {
  return JSON.parse(content.replaceAll(/,(\s*[}\]])/g, '$1'))
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
 * Map alias -> upstream name from `npm:` aliases declared in root and vendor
 * `package.json`s, so the CSV records the upstream component instead of the alias.
 *
 * @returns {Map<string, string>}
 */
function collectAliasMap () {
  const map = new Map()
  collectAliasesFromPackageJson(rootPackageJson, map)
  const vendorPath = join(repoRoot, 'vendor', 'package.json')
  if (existsSync(vendorPath)) collectAliasesFromPackageJson(require(vendorPath), map)
  return map
}

/**
 * @param {{ dependencies?: Record<string, string>, optionalDependencies?: Record<string, string> }} pkg
 * @param {Map<string, string>} map
 */
function collectAliasesFromPackageJson (pkg, map) {
  for (const section of ['dependencies', 'optionalDependencies']) {
    for (const [alias, spec] of Object.entries(pkg[section] ?? {})) {
      if (typeof spec !== 'string' || !spec.startsWith('npm:')) continue
      const rawTarget = spec.slice('npm:'.length)
      const atIndex = rawTarget.lastIndexOf('@')
      const target = atIndex > 0 ? rawTarget.slice(0, atIndex) : rawTarget
      if (target) map.set(alias, target)
    }
  }
}

/**
 * @param {string} content
 * @returns {Map<string, { component: string, origin: string, license: string, copyright: string }>}
 */
function parseCsv (content) {
  const rows = new Map()
  const lines = content.split('\n')
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const parsed = parseCsvLine(line)
    if (!parsed) continue
    rows.set(parsed.component, parsed)
  }
  return rows
}

/**
 * Splits a single CSV line into the four columns the project's
 * `LICENSE-3rdparty.csv` ships. Values are double-quoted; embedded quotes use
 * the standard `""` escape. The license + copyright columns hold Python-list
 * strings (`['MIT']`, `['Author']`) which we treat as opaque.
 *
 * @param {string} line
 */
function parseCsvLine (line) {
  const cols = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        current += '"'
        i++
      } else if (c === '"') {
        inQuotes = false
      } else {
        current += c
      }
    } else if (c === ',') {
      cols.push(current)
      current = ''
    } else if (c === '"') {
      inQuotes = true
    } else {
      current += c
    }
  }
  cols.push(current)
  if (cols.length < 4) return null
  return { component: cols[0], origin: cols[1], license: cols[2], copyright: cols[3] }
}

/**
 * Fill in `origin`/`license`/`copyright` for every wanted component, preferring
 * what the previously-committed CSV had so reviewers don't see noise from npm
 * registry copy edits and so the same metadata is preserved for re-runs. Only
 * components with no prior row are fetched from the registry.
 *
 * @param {Map<string, { name: string, version?: string }>} wanted
 * @param {Map<string, { component: string, origin: string, license: string, copyright: string }>} previous
 */
async function fillMissingMetadata (wanted, previous) {
  const out = []
  /** @type {Array<{ name: string, version?: string }>} */
  const toFetch = []
  for (const entry of wanted.values()) {
    if (entry.isRoot) {
      out.push({ component: entry.name, ...rootSelfMetadata() })
      continue
    }
    const prev = previous.get(entry.name)
    if (prev) {
      out.push(prev)
    } else {
      toFetch.push(entry)
    }
  }
  if (toFetch.length === 0) return out

  const queue = [...toFetch]
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const entry = queue.shift()
      // eslint-disable-next-line no-await-in-loop
      const meta = await fetchPackageMetadata(entry.name, entry.version)
      out.push({
        component: entry.name,
        origin: meta.origin,
        license: meta.license,
        copyright: meta.copyright,
      })
    }
  }))

  return out
}

/**
 * Self-row metadata for the root project — sourced from `package.json` rather
 * than the npm registry so the CSV records what the local checkout actually
 * publishes (the latest dd-trace on the registry is a different version line).
 *
 * @returns {{ origin: string, license: string, copyright: string }}
 */
function rootSelfMetadata () {
  const repo = rootPackageJson.repository
  const repoUrl = typeof repo === 'string' ? repo : repo?.url
  const origin = repoUrl ? normalizeRepoUrl(repoUrl) : `npm:${rootPackageJson.name}`
  const author = rootPackageJson.author
  let authorString = ''
  if (typeof author === 'string') authorString = author
  else if (author && typeof author === 'object') {
    authorString = `${author.name ?? ''}${author.email ? ` <${author.email}>` : ''}`
  }
  return {
    origin,
    license: pythonList(rootPackageJson.license ? [String(rootPackageJson.license)] : []),
    copyright: pythonList(authorString ? [authorString] : []),
  }
}

/**
 * @param {string} name
 * @param {string} [version]
 * @returns {Promise<{ origin: string, license: string, copyright: string }>}
 */
async function fetchPackageMetadata (name, version) {
  const url = version
    ? `${REGISTRY}/${encodeRegistryName(name)}/${encodeURIComponent(version)}`
    : `${REGISTRY}/${encodeRegistryName(name)}/latest`
  const data = await getJson(url).catch(() => null)
  if (!data) return { origin: `npm:${name}`, license: '[]', copyright: '[]' }

  return {
    origin: extractOrigin(data, name),
    license: pythonList(data.license ? [String(data.license)] : []),
    copyright: pythonList(extractCopyright(data)),
  }
}

/**
 * @param {string} name
 */
function encodeRegistryName (name) {
  // Scoped names keep the leading `@` and the slash; everything else is URL-encoded.
  if (!name.startsWith('@')) return encodeURIComponent(name)
  const slash = name.indexOf('/')
  return slash === -1
    ? encodeURIComponent(name)
    : `@${encodeURIComponent(name.slice(1, slash))}/${encodeURIComponent(name.slice(slash + 1))}`
}

/**
 * @param {{ repository?: string | { url?: string }, homepage?: string }} data
 * @param {string} name
 */
function extractOrigin (data, name) {
  const repo = data.repository
  const repoUrl = typeof repo === 'string' ? repo : repo?.url
  if (typeof repoUrl === 'string' && repoUrl.length > 0) return normalizeRepoUrl(repoUrl)
  if (typeof data.homepage === 'string' && data.homepage.length > 0) return data.homepage
  return `npm:${name}`
}

/**
 * @param {string} url
 */
function normalizeRepoUrl (url) {
  return url
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/\.git$/, '')
}

/**
 * @param {{ author?: string | { name?: string }, contributors?: Array<string | { name?: string }> }} data
 */
function extractCopyright (data) {
  const out = []
  const author = data.author
  if (typeof author === 'string' && author.length > 0) out.push(author.replace(/\s*<[^>]+>\s*/, '').trim())
  else if (author && typeof author === 'object' && typeof author.name === 'string') out.push(author.name)

  for (const contributor of data.contributors ?? []) {
    if (typeof contributor === 'string') out.push(contributor.replace(/\s*<[^>]+>\s*/, '').trim())
    else if (contributor && typeof contributor === 'object' && typeof contributor.name === 'string') {
      out.push(contributor.name)
    }
  }
  return out
}

/**
 * dd-license-attribution emits Python-style lists (`['MIT']`); preserve that
 * shape so reviewers see byte-identical CSVs across runs unless something real
 * changes. Strings inside use single quotes and `\\'` for embedded `'`.
 *
 * @param {string[]} items
 */
function pythonList (items) {
  if (items.length === 0) return '[]'
  const escaped = items.map(item => {
    return `'${String(item).replaceAll('\\', '\\\\').replaceAll("'", String.raw`\'`)}'`
  })
  return `[${escaped.join(', ')}]`
}

/**
 * @param {string} url
 * @returns {Promise<unknown>}
 */
function getJson (url) {
  return /** @type {Promise<unknown>} */ (new Promise((resolve, reject) => {
    request(url, { method: 'GET', headers: { accept: 'application/json' } }, response => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400 && response.headers.location) {
        getJson(response.headers.location).then(resolve, reject)
        response.resume()
        return
      }
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        if (status >= 200 && status < 300) {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (error) {
            reject(error)
          }
        } else {
          reject(new Error(`GET ${url} -> ${status}`))
        }
      })
      response.on('error', reject)
    }).on('error', reject).end()
  }))
}

/**
 * @param {Array<{ component: string, origin: string, license: string, copyright: string }>} entries
 */
function formatCsv (entries) {
  const sorted = [...entries].sort((a, b) => a.component.localeCompare(b.component))
  const lines = ['"component","origin","license","copyright"']
  for (const entry of sorted) {
    lines.push(`"${entry.component}","${entry.origin}","${escapeCsv(entry.license)}","${escapeCsv(entry.copyright)}"`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * @param {string} value
 */
function escapeCsv (value) {
  return value.replaceAll('"', '""')
}
