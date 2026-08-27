'use strict'

const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const { createHash } = require('node:crypto')

const instrumentations = require('../../datadog-instrumentations/src/helpers/instrumentations')
const hooks = require('../../datadog-instrumentations/src/helpers/hooks')
const {
  filename,
  getDisabledInstrumentations,
  matchVersion,
} = require('../../datadog-instrumentations/src/helpers/instrumentation-utils')
const { isESMFile, processModule } = require('../../datadog-esbuild/src/utils')

const CACHE_DIRECTORY = path.join('node_modules', '.cache', 'dd-trace', 'turbopack')

/**
 * Builds the Turbopack manifest and generated ESM proxies for supported
 * instrumentation targets installed in an application.
 *
 * @param {string} projectDir
 * @returns {Promise<{ esmImportPattern?: RegExp, hash?: string, packagePathPattern?: RegExp, path?: string }>}
 */
async function createManifest (projectDir) {
  projectDir = path.resolve(projectDir)
  const disabledInstrumentations = getDisabledInstrumentations()
  loadInstrumentations()

  const appRequire = Module.createRequire(path.join(projectDir, 'package.json'))
  const cacheDirectory = path.join(projectDir, CACHE_DIRECTORY)
  const targets = getTargets(appRequire, disabledInstrumentations, projectDir)
  const relativeTargets = getRelativeTargets(targets, disabledInstrumentations)
  const manifestTargets = {}

  if (targets.length === 0 && relativeTargets.length === 0) return {}

  let artifactDirectory
  try {
    await fs.mkdir(cacheDirectory, { recursive: true })
    artifactDirectory = await fs.mkdtemp(path.join(cacheDirectory, 'build-'))
  } catch {
    return {}
  }
  const realCacheDirectory = normalizePath(artifactDirectory)

  for (const [index, target] of targets.entries()) {
    const entry = {
      esm: target.esm,
      moduleBaseDir: target.moduleBaseDir,
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
          target.path, proxyPath, target.name, target.specifier, target.version, target.moduleBaseDir
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
  const manifest = JSON.stringify({ relativeTargets, targets: manifestTargets })
  try {
    await fs.writeFile(manifestPath, manifest)
  } catch {
    return {}
  }

  const packageNames = [...new Set(targets.map(target => target.name))]
  const packagePathPattern = new RegExp([
    `(?:^|/)node_modules/(?:${packageNames.map(escapeRegExp).join('|')})(?:/|$)`,
    ...new Set(targets.map(target => `${escapeRegExp(target.moduleBaseDir)}(?:/|$)`)),
  ].join('|'))
  const esmPackageNames = [...new Set(targets.filter(target => target.esm).map(target => target.name))]
  const esmPackagePattern = esmPackageNames.map(escapeRegExp).join('|')
  const importGap = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\r\n]*)*`
  const esmImportPattern = esmPackageNames.length > 0 && new RegExp([
    String.raw`\b(?:from${importGap}`,
    String.raw`|import${importGap}(?:\(${importGap})?`,
    String.raw`|require${importGap}\(${importGap}`,
    `)["'](?:${esmPackagePattern})(?:/[^"']*)?["']`,
  ].join(''))

  const relativePathPattern = relativeTargets.length > 0 && new RegExp(
    `(?:^|/)(?:${relativeTargets.map(target => escapeRegExp(target.file)).join('|')})$`
  )

  return {
    esmImportPattern,
    hash: createHash('sha256').update(manifest).digest('hex'),
    packagePathPattern,
    path: manifestPath,
    relativePathPattern,
  }
}

/**
 * Ensures the existing instrumentation declarations have populated their
 * shared registry before we inspect it at build time.
 */
function loadInstrumentations () {
  const disabledInstrumentations = getDisabledInstrumentations()
  for (const [name, hook] of Object.entries(hooks)) {
    if (disabledInstrumentations.has(name)) continue
    const load = hook?.fn ?? hook
    if (typeof load === 'function') load()
  }
}

/**
 * @param {Function & { resolve: Function }} appRequire
 * @param {Set<string>} [disabledInstrumentations]
 * @param {string} [projectDir]
 * @returns {Array<{
 *   esm: boolean, instrumentationPath: string, moduleBaseDir: string, name: string,
 *   path: string, specifier: string, version: string
 * }>}
 */
function getTargets (appRequire, disabledInstrumentations = new Set(), projectDir) {
  const targets = new Map()
  const packageNames = new Set(
    Object.keys(instrumentations).filter(name => !name.startsWith('node:') && !name.startsWith('.'))
  )
  const packageRootsByName = projectDir ? findPackageRoots(projectDir, packageNames) : new Map()

  for (const [name, entries] of Object.entries(instrumentations)) {
    if (name.startsWith('node:') || name.startsWith('.') || disabledInstrumentations.has(name)) continue

    const packageRoots = [...(packageRootsByName.get(name) ?? [])]
    if (packageRoots.length === 0) {
      try {
        const entrypoint = resolveImport(appRequire, name)
        const packageRoot = findPackageRoot(entrypoint)
        if (packageRoot) packageRoots.push(packageRoot)
      } catch {
        continue
      }
    }

    for (const packageRoot of packageRoots) {
      addTargets(targets, packageRoot, name, entries)
    }
  }

  return [...targets.values()]
}

function getRelativeTargets (targets, disabledInstrumentations) {
  const relativeTargets = []

  for (const [name, entries] of Object.entries(instrumentations)) {
    if (!name.startsWith('.') || disabledInstrumentations.has(name)) continue

    for (const entry of entries) {
      if (!entry.file) continue
      const compatibleTarget = targets.find(target => matchVersion(target.version, entry.versions) &&
        instrumentations[target.name]?.some(candidate =>
          candidate.hook === entry.hook && matchVersion(target.version, candidate.versions)
        )
      )
      if (!compatibleTarget) continue

      relativeTargets.push({
        file: entry.file,
        name,
        path: name,
        version: compatibleTarget.version,
      })
    }
  }

  return relativeTargets
}

function addTargets (targets, packageRoot, name, entries) {
  let packageJson
  let entrypoint
  try {
    packageJson = JSON.parse(fsSync.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
    entrypoint = resolvePackageEntrypoint(packageRoot, name)
  } catch {
    return
  }

  for (const entry of entries) {
    if (!matchVersion(packageJson.version, entry.versions)) continue

    let files
    try {
      files = entry.file
        ? [path.join(packageRoot, entry.file)]
        : entry.filePattern
          ? findMatchingFiles(packageRoot, new RegExp(entry.filePattern))
          : [entrypoint]
    } catch {
      continue
    }

    for (const file of files) {
      if (!fsSync.existsSync(file)) continue
      const modulePath = entry.file || (entry.filePattern &&
        path.relative(packageRoot, file).replaceAll('\\', '/'))

      targets.set(normalizePath(file), {
        esm: isESMFile(file, path.join(packageRoot, 'package.json'), packageJson),
        instrumentationPath: filename(name, modulePath),
        moduleBaseDir: packageRoot,
        name,
        path: file,
        specifier: modulePath ? `${name}/${modulePath}` : name,
        version: packageJson.version,
      })
    }
  }
}

// Visit package boundaries only: this reaches nested dependency copies without
// walking each package's source tree during Next configuration.
function findPackageRoots (projectDir, names) {
  const packageRoots = new Map()
  const pending = [path.join(projectDir, 'node_modules')]
  const seen = new Set()

  while (pending.length > 0) {
    const nodeModules = pending.pop()
    let directory
    try {
      directory = normalizePath(nodeModules)
    } catch {
      continue
    }
    if (seen.has(directory)) continue
    seen.add(directory)

    let entries
    try {
      entries = fsSync.readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === '.bin') continue
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const entryPath = path.join(directory, entry.name)
      if (entry.name.startsWith('@')) {
        addScopedPackageRoots(entryPath, names, packageRoots, pending)
      } else {
        addPackageRoot(entryPath, entry.name, names, packageRoots, pending)
      }
    }
  }

  return packageRoots
}

function addScopedPackageRoots (scopePath, names, packageRoots, pending) {
  let entries
  try {
    entries = fsSync.readdirSync(scopePath, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    addPackageRoot(
      path.join(scopePath, entry.name),
      `${path.basename(scopePath)}/${entry.name}`,
      names,
      packageRoots,
      pending
    )
  }
}

function addPackageRoot (packageRoot, packageName, names, packageRoots, pending) {
  let realPackageRoot
  try {
    realPackageRoot = normalizePath(packageRoot)
  } catch {
    return
  }

  if (names.has(packageName)) {
    const roots = packageRoots.get(packageName) ?? new Set()
    roots.add(realPackageRoot)
    packageRoots.set(packageName, roots)
  }
  // pnpm stores a package's dependencies beside the real package directory,
  // not beneath it. Traversing the containing node_modules reaches those
  // virtual-store siblings while remaining a no-op for ordinary installs.
  const pendingDirectories = [path.join(realPackageRoot, 'node_modules')]
  const containingNodeModules = findNodeModulesRoot(realPackageRoot)
  if (containingNodeModules) pendingDirectories.push(containingNodeModules)
  pending.push(...pendingDirectories)
}

function createPackageRequire (packageRoot) {
  const nodeModules = findNodeModulesRoot(packageRoot)
  return Module.createRequire(path.join(
    nodeModules ? path.dirname(nodeModules) : packageRoot,
    'package.json'
  ))
}

function findNodeModulesRoot (packageRoot) {
  let directory = packageRoot
  while (directory !== path.dirname(directory)) {
    if (path.basename(directory) === 'node_modules') return directory
    directory = path.dirname(directory)
  }
}

function resolvePackageEntrypoint (packageRoot, name) {
  const packageRequire = createPackageRequire(packageRoot)
  try {
    return packageRequire.resolve(name, { conditions: new Set(['import', 'node']) })
  } catch {
    return resolveImport(Module.createRequire(path.join(packageRoot, 'package.json')), '.')
  }
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
 * @param {string} moduleBaseDir
 * @returns {Promise<string>}
 */
async function createEsmProxy (sourcePath, proxyPath, name, specifier, version, moduleBaseDir) {
  const setters = await processModule({
    path: sourcePath,
    context: { format: 'module' },
    nonEvaluating: true,
  })
  return `import { channel } from 'node:diagnostics_channel';
import * as namespace from ${JSON.stringify(relativeImport(path.dirname(proxyPath), sourcePath))};
const _ = Object.create(null, { [Symbol.toStringTag]: { value: 'Module' } });
const set = {};
const get = {};
${[...setters.values()].join(';\n')};
channel('dd-trace:bundler:load').publish({
  package: ${JSON.stringify(name)},
  module: _,
  moduleBaseDir: ${JSON.stringify(moduleBaseDir)},
  moduleName: ${JSON.stringify(sourcePath)},
  path: ${JSON.stringify(specifier)},
  version: ${JSON.stringify(version)},
  apply (exports, patchDefault) {
    if (patchDefault) return set.default?.(exports);
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
  getRelativeTargets,
  getTargets,
}
