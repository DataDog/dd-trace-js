'use strict'

const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const Module = require('node:module')
const path = require('node:path')

const instrumentations = require('../../datadog-instrumentations/src/helpers/instrumentations')
const hooks = require('../../datadog-instrumentations/src/helpers/hooks')
const { filename, matchVersion } = require('../../datadog-instrumentations/src/helpers/register')
const { isESMFile, processModule } = require('../../datadog-esbuild/src/utils')

const CACHE_DIRECTORY = path.join('node_modules', '.cache', 'dd-trace', 'turbopack')

/**
 * Builds the Turbopack manifest and generated ESM proxies for supported
 * instrumentation targets installed in an application.
 *
 * @param {string} projectDir
 * @returns {Promise<{ esmImportPattern?: RegExp, packagePathPattern?: RegExp, path?: string }>}
 */
async function createManifest (projectDir) {
  loadInstrumentations()

  const appRequire = Module.createRequire(path.join(projectDir, 'package.json'))
  const cacheDirectory = path.join(projectDir, CACHE_DIRECTORY)
  const targets = getTargets(appRequire)
  const manifestTargets = {}

  if (targets.length === 0) return {}

  await fs.mkdir(cacheDirectory, { recursive: true })
  const realCacheDirectory = normalizePath(cacheDirectory)

  for (const [index, target] of targets.entries()) {
    const entry = {
      esm: target.esm,
      name: target.name,
      path: target.instrumentationPath,
      version: target.version,
    }

    if (target.esm) {
      const proxyPath = path.join(realCacheDirectory, `${index}.mjs`)
      try {
        // Proxies are build-time artifacts; preserve source order for stable paths.
        // eslint-disable-next-line no-await-in-loop
        await fs.writeFile(proxyPath, await createEsmProxy(
          target.path, proxyPath, target.name, target.specifier, target.version
        ))
      } catch {
        // An unsupported dependency must not prevent the customer's build. Its
        // original module remains bundled without instrumentation instead.
        continue
      }
      entry.proxyPath = normalizePath(proxyPath)
    }

    manifestTargets[normalizePath(target.path)] = entry
  }

  const manifestPath = path.join(realCacheDirectory, 'manifest.json')
  await fs.writeFile(manifestPath, JSON.stringify({ targets: manifestTargets }))

  const packageNames = [...new Set(targets.map(target => target.name))]
  const packagePathPattern = new RegExp(
    `(?:^|/)node_modules/(?:${packageNames.map(escapeRegExp).join('|')})(?:/|$)`
  )
  const esmPackageNames = [...new Set(targets.filter(target => target.esm).map(target => target.name))]
  const esmPackagePattern = esmPackageNames.map(escapeRegExp).join('|')
  const esmImportPattern = esmPackageNames.length > 0 && new RegExp(
    String.raw`\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["'](?:${esmPackagePattern})(?:/[^"']*)?["']`
  )

  return { esmImportPattern, packagePathPattern, path: manifestPath }
}

/**
 * Ensures the existing instrumentation declarations have populated their
 * shared registry before we inspect it at build time.
 */
function loadInstrumentations () {
  for (const hook of Object.values(hooks)) {
    const load = hook?.fn ?? hook
    if (typeof load === 'function') load()
  }
}

/**
 * @param {Function & { resolve: Function }} appRequire
 * @returns {Array<{
 *   esm: boolean, instrumentationPath: string, name: string,
 *   path: string, specifier: string, version: string
 * }>}
 */
function getTargets (appRequire) {
  const targets = new Map()

  for (const [name, entries] of Object.entries(instrumentations)) {
    if (name.startsWith('node:') || name.startsWith('.')) continue

    let entrypoint
    try {
      entrypoint = resolveImport(appRequire, name)
    } catch {
      continue
    }

    const packageRoot = findPackageRoot(entrypoint)
    if (!packageRoot) continue

    let packageJson
    try {
      packageJson = JSON.parse(fsSync.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!matchVersion(packageJson.version, entry.versions)) continue

      const files = entry.file
        ? [path.join(packageRoot, entry.file)]
        : entry.filePattern
          ? findMatchingFiles(packageRoot, new RegExp(entry.filePattern))
          : [entrypoint]

      for (const file of files) {
        if (!fsSync.existsSync(file)) continue
        const modulePath = entry.file || (entry.filePattern &&
          path.relative(packageRoot, file).replaceAll('\\', '/'))

        targets.set(normalizePath(file), {
          esm: isESMFile(file, path.join(packageRoot, 'package.json'), packageJson),
          instrumentationPath: filename(name, modulePath),
          name,
          path: file,
          specifier: modulePath ? `${name}/${modulePath}` : name,
          version: packageJson.version,
        })
      }
    }
  }

  return [...targets.values()]
}

/**
 * Resolves with import conditions so an ESM package uses the same entrypoint
 * as a Turbopack Node bundle instead of the CommonJS require entrypoint.
 *
 * @param {Function & { resolve: Function }} appRequire
 * @param {string} specifier
 * @returns {string}
 */
function resolveImport (appRequire, specifier) {
  return appRequire.resolve(specifier, { conditions: new Set(['import', 'node']) })
}

/**
 * @param {string} file
 * @returns {string|undefined}
 */
function findPackageRoot (file) {
  let directory = path.dirname(file)
  while (directory !== path.dirname(directory)) {
    if (fsSync.existsSync(path.join(directory, 'package.json'))) return directory
    directory = path.dirname(directory)
  }
}

/**
 * @param {string} directory
 * @param {RegExp} pattern
 * @returns {string[]}
 */
function findMatchingFiles (directory, pattern) {
  const files = []
  const pending = [directory]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of fsSync.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory() && entry.name !== 'node_modules') {
        pending.push(target)
      } else if (entry.isFile()) {
        const relativePath = path.relative(directory, target).replaceAll('\\', '/')
        if (pattern.test(relativePath)) files.push(target)
      }
    }
  }
  return files
}

/**
 * @param {string} sourcePath
 * @param {string} proxyPath
 * @param {string} name
 * @param {string} specifier
 * @param {string} version
 * @returns {Promise<string>}
 */
async function createEsmProxy (sourcePath, proxyPath, name, specifier, version) {
  const setters = await processModule({ path: sourcePath, context: { format: 'module' } })
  const dcPolyfillPath = relativeImport(
    path.dirname(proxyPath),
    require.resolve('dc-polyfill')
  )
  return `import dc from ${JSON.stringify(dcPolyfillPath)};
import * as namespace from ${JSON.stringify(relativeImport(path.dirname(proxyPath), sourcePath))};
const _ = Object.create(null, { [Symbol.toStringTag]: { value: 'Module' } });
const set = {};
const get = {};
${[...setters.values()].join(';\n')};
dc.channel('dd-trace:bundler:load').publish({
  package: ${JSON.stringify(name)},
  module: _,
  path: ${JSON.stringify(specifier)},
  version: ${JSON.stringify(version)},
  apply (exports) {
    for (const name of Object.keys(exports)) set[name]?.(exports[name]);
  },
});
`
}

function relativeImport (from, to) {
  let value = path.relative(from, to).replaceAll('\\', '/')
  if (!value.startsWith('.')) value = `./${value}`
  return value
}

function normalizePath (value) {
  return fsSync.realpathSync(value).replaceAll('\\', '/')
}

function escapeRegExp (value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

module.exports = {
  createEsmProxy,
  createManifest,
  getTargets,
}
