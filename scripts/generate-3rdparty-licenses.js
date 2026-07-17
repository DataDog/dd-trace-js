#!/usr/bin/env node

/* eslint-disable no-console */
'use strict'

// Regenerate `LICENSE-3rdparty.csv` from the locks the project currently ships:
// `bun.lock` for runtime + optional root deps, `vendor/bun.lock` for the vendored
// subtree, and `.github/vendored-dependencies.csv` for the vendor
// entries we ship verbatim. The output matches the format the previous
// `dd-license-attribution` CSV produced (`component,origin,license,copyright`,
// values in Python-list strings) so reviewers see only meaningful diffs when
// the dep tree changes.
//
// Usage:
//   node scripts/generate-3rdparty-licenses.js --check   # exit 1 if CSV drifted
//   node scripts/generate-3rdparty-licenses.js           # rewrite CSV in place

const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { request } = require('node:https')

const rootPackageJson = require('../package.json')
const mapWithConcurrency = require('./helpers/concurrency')
const {
  collectAliasMap,
  listBunLockDependencies,
} = require('./third-party-dependencies')

const repoRoot = join(__dirname, '..')
const csvPath = join(repoRoot, 'LICENSE-3rdparty.csv')
const bunLockPath = join(repoRoot, 'bun.lock')
const vendorLockPath = join(repoRoot, 'vendor', 'bun.lock')
const vendoredCsvPath = join(repoRoot, '.github', 'vendored-dependencies.csv')
const aliasMap = collectAliasMap([
  join(repoRoot, 'package.json'),
  join(repoRoot, 'vendor', 'package.json'),
])
const REGISTRY = 'https://registry.npmjs.org'
const FETCH_CONCURRENCY = 16

/**
 * @typedef {{
 *   author?: string | { name?: string },
 *   contributors?: Array<string | { name?: string }>,
 *   homepage?: string,
 *   license?: string | { type?: string },
 *   licenses?: Array<string | { type?: string }>,
 *   repository?: string | { url?: string }
 * }} RegistryPackageMetadata
 */

/**
 * @typedef {{
 *   name: string,
 *   versions?: Set<string>,
 *   isRoot?: boolean,
 *   metadata?: { component: string, origin: string, license: string, copyright: string }
 * }} WantedComponent
 */

run().catch(error => {
  console.error(error)
  process.exit(1)
})

async function run () {
  const wanted = collectWantedComponents()
  const previous = parseCsv(readFileSync(csvPath, 'utf8'))
  const augmented = await fillMetadata(wanted, previous)
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
 * `vendor/bun.lock` and return a map of `<component> -> { name, version }`,
 * normalized via `npm:` aliases declared in `package.json` so e.g. an aliased
 * `@datadog/source-map -> source-map` is recorded under the upstream name.
 *
 * @returns {Map<string, WantedComponent>}
 */
function collectWantedComponents () {
  // The previous generator (`dd-license-attribution`) recorded the project
  // itself as a row keyed by the root `package.json`'s `name`. Seed the map
  // with that self-row so the CSV diff stays narrow.
  const wanted = new Map([
    [rootPackageJson.name, { name: rootPackageJson.name, isRoot: true }],
  ])

  for (const { name, version } of listBunLockDependencies(bunLockPath)) {
    addWantedVersion(wanted, name, version)
  }
  for (const { name, version } of listBunLockDependencies(vendorLockPath)) {
    addWantedVersion(wanted, name, version)
  }

  for (const metadata of parseCsv(readFileSync(vendoredCsvPath, 'utf8'), false).values()) {
    wanted.set(metadata.component, { name: metadata.component, metadata })
  }

  return wanted
}

/**
 * @param {Map<string, WantedComponent>} wanted
 * @param {string} name
 * @param {string} version
 */
function addWantedVersion (wanted, name, version) {
  const normalized = aliasMap.get(name) ?? name
  let component = wanted.get(normalized)
  if (!component) {
    component = { name: normalized, versions: new Set() }
    wanted.set(normalized, component)
  }
  component.versions ??= new Set()
  component.versions.add(version)
}

/**
 * @param {string} content
 * @param {boolean} [hasHeader]
 * @returns {Map<string, { component: string, origin: string, license: string, copyright: string }>}
 */
function parseCsv (content, hasHeader = true) {
  const rows = new Map()
  const lines = content.split('\n')
  for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
    const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i]
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
 * @param {Map<string, WantedComponent>} wanted
 * @param {Map<string, { component: string, origin: string, license: string, copyright: string }>} previous
 */
async function fillMetadata (wanted, previous) {
  const out = []
  /** @type {Array<{ name: string, version: string }>} */
  const toFetch = []
  for (const entry of wanted.values()) {
    if (entry.isRoot) {
      out.push({ component: entry.name, ...rootSelfMetadata() })
      continue
    }
    if (entry.metadata) {
      out.push(entry.metadata)
      continue
    }
    for (const version of entry.versions ?? []) {
      if (!version) throw new Error(`Cannot fetch exact npm metadata for ${entry.name} without a locked version`)
      toFetch.push({ name: entry.name, version })
    }
  }

  /** @type {Map<string, Array<Awaited<ReturnType<typeof fetchPackageMetadata>>>>} */
  const metadataByName = new Map()
  const fetchedMetadata = await mapWithConcurrency(
    toFetch,
    FETCH_CONCURRENCY,
    fetchPackageMetadata
  )
  for (let i = 0; i < toFetch.length; i++) {
    const name = toFetch[i].name
    const componentMetadata = metadataByName.get(name)
    if (componentMetadata) {
      componentMetadata.push(fetchedMetadata[i])
    } else {
      metadataByName.set(name, [fetchedMetadata[i]])
    }
  }

  for (const [name, metadata] of metadataByName) {
    const licenses = new Set()
    const copyright = new Set()
    for (const { licenses: packageLicenses, copyright: packageCopyright } of metadata) {
      for (const license of packageLicenses) licenses.add(license)
      for (const owner of packageCopyright) copyright.add(owner)
    }
    const prev = previous.get(name)
    out.push({
      component: name,
      origin: prev?.origin ?? metadata[0].origin,
      license: pythonList([...licenses]),
      copyright: prev && metadata.length === 1 ? prev.copyright : pythonList([...copyright]),
    })
  }

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
 * @param {{ name: string, version: string }} entry
 * @returns {Promise<{ origin: string, licenses: string[], copyright: string[] }>}
 */
async function fetchPackageMetadata ({ name, version }) {
  const url = `${REGISTRY}/${encodeRegistryName(name)}/${encodeURIComponent(version)}`
  const data = await getJson(url)
  const licenses = extractLicenses(data)
  if (licenses.length === 0) {
    throw new Error(`${name}@${version} does not declare a license in npm metadata`)
  }

  return {
    origin: extractOrigin(data, name),
    licenses,
    copyright: extractCopyright(data),
  }
}

/**
 * @param {RegistryPackageMetadata} data
 * @returns {string[]}
 */
function extractLicenses (data) {
  const licenses = []
  addLicense(data.license, licenses)
  for (const license of data.licenses ?? []) addLicense(license, licenses)
  return [...new Set(licenses)]
}

/**
 * @param {string | { type?: string } | undefined} license
 * @param {string[]} licenses
 */
function addLicense (license, licenses) {
  if (typeof license === 'string') {
    licenses.push(license)
  } else if (license && typeof license.type === 'string') {
    licenses.push(license.type)
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
 * @param {RegistryPackageMetadata} data
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
 * @param {RegistryPackageMetadata} data
 */
function extractCopyright (data) {
  const out = []
  const author = extractName(data.author)
  if (author) out.push(author)
  for (const contributor of data.contributors ?? []) {
    const name = extractName(contributor)
    if (name) out.push(name)
  }
  return out
}

/**
 * npm's `author` / `contributors` entries are either strings shaped like
 * `Name <email> (url)` or objects with `name` / `email` / `url` fields.
 * Pull just the name out of either shape so the CSV `copyright` column
 * matches what `dd-license-attribution` emitted (no email, no URL,
 * trimmed). Slicing to the first `<` or `(` avoids the regex-on-untrusted-
 * input pattern CodeQL flags.
 *
 * @param {string | { name?: string } | undefined} entry
 * @returns {string}
 */
function extractName (entry) {
  if (typeof entry === 'string') {
    let cut = entry.length
    for (const sep of ['<', '(']) {
      const at = entry.indexOf(sep)
      if (at !== -1 && at < cut) cut = at
    }
    return entry.slice(0, cut).trim()
  }
  if (entry && typeof entry === 'object' && typeof entry.name === 'string') return entry.name.trim()
  return ''
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
 * @returns {Promise<RegistryPackageMetadata>}
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
    lines.push(
      `"${escapeCsv(entry.component)}","${escapeCsv(entry.origin)}",` +
      `"${escapeCsv(entry.license)}","${escapeCsv(entry.copyright)}"`
    )
  }
  return `${lines.join('\n')}\n`
}

/**
 * @param {string} value
 */
function escapeCsv (value) {
  return value.replaceAll('"', '""')
}
