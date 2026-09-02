'use strict'

const { createHash, randomUUID } = require('node:crypto')
const fsSync = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')
const { fileURLToPath, pathToFileURL } = require('node:url')

const enhancedResolve = require('enhanced-resolve')

const { BUNDLER_DC_GLOBAL } = require('../../datadog-instrumentations/src/helpers/bundler-constants')
const instrumentations = require('../../datadog-instrumentations/src/helpers/instrumentations')
const hooks = require('../../datadog-instrumentations/src/helpers/hooks')
const {
  errorMessage,
  filename,
  matchVersion,
} = require('../../datadog-instrumentations/src/helpers/instrumentation-utils')
const { isESMFile, processModule } = require('../../datadog-esbuild/src/utils')
const { parseSource } = require('./compiler')

const CACHE_DIRECTORY = path.join('cache', 'dd-trace', 'turbopack')
const CHANNEL = 'dd-trace:bundler:load'
const MAX_WARNINGS = 128
const PLAN_VERSION = 4
const TRAILING_WHITESPACE = /[ \t]+$/gm
const resolveImport = enhancedResolve.create.sync({ conditionNames: ['node', 'import'] })
const resolveRequire = enhancedResolve.create.sync({ conditionNames: ['node', 'require'] })

/** @type {Set<string>} */
const emittedWarnings = new Set()

/**
 * @typedef {object} InstrumentationPayload
 * @property {string} [integration]
 * @property {string} moduleName
 * @property {string} package
 * @property {string} path
 * @property {string} version
 */

/**
 * @typedef {object} Target
 * @property {Array<{ path: string, sourceHash: string }>} [dependencies]
 * @property {boolean} esm
 * @property {Array<{ hook: Function, payload: InstrumentationPayload, version: string }>} matches
 * @property {InstrumentationPayload[]} payloads
 * @property {string} path
 * @property {{ moduleName: string, filePath: string }} rewriteTarget
 * @property {Set<string>} rulePaths
 * @property {string} sourceHash
 * @property {string[]} [setters]
 * @property {string[]} [liveExports]
 */

/**
 * Compiles installed integration targets into immutable build artifacts.
 *
 * @param {string} projectDir
 * @param {{ compiler: { parser: string, traverse: string }, distDir?: string }} settings
 * @returns {Promise<{
 *   hash?: string,
 *   moduleSyntaxPattern?: RegExp,
 *   packagePathPattern?: RegExp,
 *   path?: string,
 *   relativePathPattern?: RegExp,
 *   targetPathPattern?: RegExp
 * }>}
 */
async function createBuildPlan (projectDir, settings) {
  projectDir = path.resolve(projectDir)
  loadInstrumentations()

  const targets = getTargets(projectDir)
  const compiledTargets = []
  let includesEsmTarget = false

  for (const target of targets) {
    try {
      const source = fsSync.readFileSync(target.path)
      target.sourceHash = hash(source)
      if (target.esm) {
        // Export discovery is asynchronous in import-in-the-middle and belongs at build time.
        const moduleSources = new Map([[fileURLToPath(pathToFileURL(target.path)), source.toString()]])
        // eslint-disable-next-line no-await-in-loop
        const setters = await processModule({
          path: target.path,
          context: { format: 'module' },
          moduleSources,
        })
        target.dependencies = createDependencies(moduleSources, target.path)
        target.liveExports = findLiveExports(source.toString(), target.path, settings.compiler, setters.keys())
        for (const name of target.liveExports) setters.delete(name)
        target.setters = [...setters.values()].map(setter => setter.replaceAll(TRAILING_WHITESPACE, ''))
        includesEsmTarget = true
      }
      compiledTargets.push(target)
    } catch (error) {
      warnOnce(`target:${target.path}`, `Could not instrument ${target.path}: ${errorMessage(error)}`)
    }
  }

  const relativeTargets = getRelativeTargets(compiledTargets)
  if (compiledTargets.length === 0 && relativeTargets.length === 0) return {}

  compiledTargets.sort(compareTargets)
  relativeTargets.sort(compareRelativeTargets)
  const identity = createPlanIdentity(compiledTargets, relativeTargets)
  const planId = hash(identity)
  const artifactDirectory = path.resolve(projectDir, settings.distDir ?? '.next', CACHE_DIRECTORY, planId)
  try {
    await fs.mkdir(artifactDirectory, { recursive: true })
  } catch (error) {
    throw new Error(`Could not create the Datadog Turbopack cache at ${artifactDirectory}: ${errorMessage(error)}`, {
      cause: error,
    })
  }
  const realArtifactDirectory = normalizePath(artifactDirectory)
  const planProxies = {}
  const planTargets = {}

  for (const target of compiledTargets) {
    const entry = {
      dependencies: target.dependencies,
      esm: target.esm,
      payloads: target.payloads,
      rewriteTarget: target.rewriteTarget,
      sourceHash: target.sourceHash,
    }

    if (target.esm) {
      const proxy = createEsmProxy(target, path.join(realArtifactDirectory, 'proxy.mjs'))
      const proxyId = hash(proxy)
      const proxyPath = path.join(realArtifactDirectory, `${proxyId}.mjs`)
      // Files are content-addressed and safe for concurrent config evaluation.
      // eslint-disable-next-line no-await-in-loop
      await writeArtifact(proxyPath, proxy)
      entry.proxyPath = normalizePath(proxyPath)
      planProxies[entry.proxyPath] = true
    }

    planTargets[target.path] = entry
  }

  const plan = JSON.stringify({
    proxies: planProxies,
    relativeTargets,
    targets: planTargets,
    version: PLAN_VERSION,
  })
  const planHash = hash(plan)
  const planPath = path.join(realArtifactDirectory, `${planHash}.json`)
  await writeArtifact(planPath, plan)

  return {
    hash: planHash,
    moduleSyntaxPattern: includesEsmTarget ? /\b(?:export|import|require)\b/ : undefined,
    packagePathPattern: createPackagePathPattern(compiledTargets),
    path: planPath,
    relativePathPattern: createRelativePathPattern(relativeTargets),
    targetPathPattern: createTargetPathPattern(compiledTargets),
  }
}

/**
 * @param {Map<string, string>} moduleSources
 * @param {string} targetPath
 * @returns {Array<{ path: string, sourceHash: string }>}
 */
function createDependencies (moduleSources, targetPath) {
  const dependencies = []
  for (const [modulePath, source] of moduleSources) {
    const dependencyPath = normalizePath(modulePath)
    if (dependencyPath === targetPath) continue
    dependencies.push({ path: dependencyPath, sourceHash: hash(source) })
  }
  dependencies.sort(compareDependencies)
  return dependencies
}

/**
 * @param {{ path: string }} left
 * @param {{ path: string }} right
 * @returns {number}
 */
function compareDependencies (left, right) {
  return left.path.localeCompare(right.path)
}

/** Loads each instrumentation declaration before target discovery. */
function loadInstrumentations () {
  for (const [name, hook] of Object.entries(hooks)) {
    const load = hook?.fn ?? hook
    if (typeof load !== 'function') continue

    try {
      load()
    } catch (error) {
      warnOnce(`hook:${name}`, `Could not load the ${name} instrumentation: ${errorMessage(error)}`)
    }
  }
}

/**
 * @param {string} projectDir
 * @returns {Target[]}
 */
function getTargets (projectDir) {
  const targets = new Map()
  const packageNames = new Set()

  for (const name of Object.keys(instrumentations)) {
    if (!name.startsWith('node:') && !name.startsWith('.')) packageNames.add(name)
  }

  const packageRootsByName = findPackageRoots(projectDir, packageNames)
  for (const [name, entries] of Object.entries(instrumentations)) {
    if (name.startsWith('node:') || name.startsWith('.')) continue

    const packageRoots = [...(packageRootsByName.get(name) ?? [])]
    if (packageRoots.length === 0) {
      addResolvedPackageRoot(packageRoots, projectDir, name, resolveImport)
      addResolvedPackageRoot(packageRoots, projectDir, name, resolveRequire)
    }

    for (const packageRoot of packageRoots) addTargets(targets, packageRoot, name, entries)
  }

  return [...targets.values()]
}

/**
 * @param {Target[]} targets
 * @returns {Array<{ file: string, payloads: InstrumentationPayload[], sourceHash: string }>}
 */
function getRelativeTargets (targets) {
  const relativeTargets = new Map()
  const ambiguousTargets = new Set()

  for (const [name, entries] of Object.entries(instrumentations)) {
    if (!name.startsWith('.')) continue

    for (const entry of entries) {
      if (!entry.file) continue

      for (const target of targets) {
        for (const match of target.matches) {
          if (match.hook !== entry.hook || !matchVersion(match.version, entry.versions)) continue

          const key = `${entry.file}\0${target.sourceHash}`
          if (ambiguousTargets.has(key)) continue

          const existing = relativeTargets.get(key)
          if (existing && existing.payloads[0].version !== match.version) {
            relativeTargets.delete(key)
            ambiguousTargets.add(key)
            continue
          }

          if (existing) continue

          relativeTargets.set(key, {
            file: entry.file.replaceAll('\\', '/'),
            payloads: [{
              integration: match.payload.package,
              moduleName: name,
              package: name,
              path: name,
              version: match.payload.version,
            }],
            sourceHash: target.sourceHash,
          })
        }
      }
    }
  }

  return [...relativeTargets.values()]
}

/**
 * @param {Map<string, Target>} targets
 * @param {string} packageRoot
 * @param {string} name
 * @param {Array<object>} entries
 */
function addTargets (targets, packageRoot, name, entries) {
  let packageJson
  try {
    packageJson = JSON.parse(fsSync.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  } catch {
    return
  }

  let entrypoints
  for (const entry of entries) {
    if (!matchVersion(packageJson.version, entry.versions)) continue

    let files
    try {
      if (entry.file) {
        files = [path.join(packageRoot, entry.file)]
      } else if (entry.filePattern) {
        files = findMatchingFiles(packageRoot, new RegExp(entry.filePattern))
      } else {
        entrypoints ??= resolvePackageEntrypoints(packageRoot, name)
        files = entrypoints
      }
    } catch {
      continue
    }

    for (const file of files) {
      if (!fsSync.existsSync(file)) continue

      const targetPath = normalizePath(file)
      const relativePath = path.relative(packageRoot, file).replaceAll('\\', '/')
      const modulePath = entry.file || (entry.filePattern && relativePath)
      const moduleName = filename(name, modulePath)
      let target = targets.get(targetPath)
      if (!target) {
        target = {
          esm: isESMFile(file, path.join(packageRoot, 'package.json'), packageJson),
          matches: [],
          path: targetPath,
          payloads: [],
          rewriteTarget: { filePath: relativePath, moduleName: name },
          rulePaths: new Set(),
          sourceHash: '',
        }
        targets.set(targetPath, target)
      }
      target.rulePaths.add(`${name}/${relativePath}`)
      target.rulePaths.add(`${path.basename(packageRoot)}/${relativePath}`)

      let payload = findPayload(target.payloads, name, moduleName, packageJson.version)
      if (!payload) {
        payload = {
          moduleName,
          package: name,
          path: moduleName,
          version: packageJson.version,
        }
        target.payloads.push(payload)
      }
      target.matches.push({ hook: entry.hook, payload, version: packageJson.version })
    }
  }
}

/**
 * @param {string[]} packageRoots
 * @param {string} directory
 * @param {string} name
 * @param {(directory: string, specifier: string) => string} resolve
 */
function addResolvedPackageRoot (packageRoots, directory, name, resolve) {
  let entrypoint
  try {
    entrypoint = resolve(directory, name)
  } catch {
    return
  }

  const packageRoot = findPackageRoot(entrypoint)
  if (packageRoot && !packageRoots.includes(packageRoot)) packageRoots.push(packageRoot)
}

/**
 * @param {InstrumentationPayload[]} payloads
 * @param {string} name
 * @param {string} moduleName
 * @param {string} version
 * @returns {InstrumentationPayload|undefined}
 */
function findPayload (payloads, name, moduleName, version) {
  for (const payload of payloads) {
    if (payload.package === name && payload.moduleName === moduleName && payload.version === version) return payload
  }
}

// Visit package boundaries only: this reaches nested dependency copies without
// walking each package's source tree during Next configuration.
/**
 * @param {string} projectDir
 * @param {Set<string>} names
 * @returns {Map<string, Set<string>>}
 */
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
      if (entry.name === '.pnpm') {
        addPnpmPackageRoots(entryPath, pending)
      } else if (entry.name.startsWith('@')) {
        addScopedPackageRoots(entryPath, names, packageRoots, pending)
      } else {
        addPackageRoot(entryPath, entry.name, names, packageRoots, pending)
      }
    }
  }

  return packageRoots
}

/**
 * @param {string} storePath
 * @param {string[]} pending
 */
function addPnpmPackageRoots (storePath, pending) {
  let entries
  try {
    entries = fsSync.readdirSync(storePath, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const entryPath = path.join(storePath, entry.name)
    pending.push(entry.name === 'node_modules' ? entryPath : path.join(entryPath, 'node_modules'))
  }
}

/**
 * @param {string} scopePath
 * @param {Set<string>} names
 * @param {Map<string, Set<string>>} packageRoots
 * @param {string[]} pending
 */
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

/**
 * @param {string} packageRoot
 * @param {string} packageName
 * @param {Set<string>} names
 * @param {Map<string, Set<string>>} packageRoots
 * @param {string[]} pending
 */
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
  pending.push(path.join(realPackageRoot, 'node_modules'))
}

/**
 * @param {string} packageRoot
 * @param {string} name
 * @returns {string[]}
 */
function resolvePackageEntrypoints (packageRoot, name) {
  const entrypoints = new Set()

  addResolvedEntrypoint(entrypoints, packageRoot, name, resolveImport)
  addResolvedEntrypoint(entrypoints, packageRoot, name, resolveRequire)
  if (entrypoints.size === 0) {
    addResolvedEntrypoint(entrypoints, packageRoot, '.', resolveImport)
    addResolvedEntrypoint(entrypoints, packageRoot, '.', resolveRequire)
  }

  return [...entrypoints]
}

/**
 * @param {Set<string>} entrypoints
 * @param {string} directory
 * @param {string} specifier
 * @param {(directory: string, specifier: string) => string} resolve
 */
function addResolvedEntrypoint (entrypoints, directory, specifier, resolve) {
  try {
    entrypoints.add(resolve(directory, specifier))
  } catch {}
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
 * @param {string} source
 * @param {string} resourcePath
 * @param {{ parser: string, traverse: string }} compiler
 * @param {Iterable<string>} exportNames
 * @returns {string[]}
 */
function findLiveExports (source, resourcePath, compiler, exportNames) {
  const { ast, traverse } = parseSource(source, resourcePath, compiler)
  const explicitExports = new Set()
  const liveExports = new Set()
  let hasExportAll = false

  traverse(ast, {
    /** @param {object} programPath */
    Program (programPath) {
      for (const statementPath of programPath.get('body')) {
        const { node } = statementPath
        if (statementPath.isExportAllDeclaration()) {
          if (node.exportKind !== 'type') hasExportAll = true
          continue
        }
        if (!statementPath.isExportNamedDeclaration()) continue

        const declarationPath = statementPath.get('declaration')
        if (declarationPath.node) {
          for (const name of Object.keys(declarationPath.getBindingIdentifiers())) {
            explicitExports.add(name)
            if (programPath.scope.getBinding(name)?.constant === false) liveExports.add(name)
          }
        }

        for (const specifier of node.specifiers) {
          if (specifier.exportKind === 'type') continue
          const exported = getExportName(specifier.exported)
          if (exported === undefined) continue

          explicitExports.add(exported)
          if (node.source) {
            liveExports.add(exported)
            continue
          }

          const local = getExportName(specifier.local)
          const binding = local === undefined ? undefined : programPath.scope.getBinding(local)
          if (!binding || binding.kind === 'module' || binding.constant === false) liveExports.add(exported)
        }
      }
    },
  })

  if (hasExportAll) {
    for (const name of exportNames) {
      if (!explicitExports.has(name)) liveExports.add(name)
    }
  }

  return [...liveExports].sort()
}

/**
 * @param {{ name?: string, value?: string }|undefined} exported
 * @returns {string|undefined}
 */
function getExportName (exported) {
  return exported?.name ?? exported?.value
}

/**
 * @param {Target[]} targets
 * @param {Array<{ file: string, payloads: InstrumentationPayload[], sourceHash: string }>} relativeTargets
 * @returns {string}
 */
function createPlanIdentity (targets, relativeTargets) {
  const identityTargets = []
  for (const target of targets) {
    identityTargets.push({
      dependencies: target.dependencies,
      esm: target.esm,
      liveExports: target.liveExports,
      path: target.path,
      payloads: target.payloads,
      rewriteTarget: target.rewriteTarget,
      setters: target.setters,
      sourceHash: target.sourceHash,
    })
  }
  return JSON.stringify({ relativeTargets, targets: identityTargets, version: PLAN_VERSION })
}

/**
 * @param {Target} target
 * @param {string} proxyPath
 * @returns {string}
 */
function createEsmProxy (target, proxyPath) {
  const targetImport = JSON.stringify(relativeImport(path.dirname(proxyPath), target.path))
  let liveReexports = ''
  let liveSnapshots = ''
  let publications = ''
  let publicationIndex = 0

  if (target.liveExports) {
    for (const name of target.liveExports) {
      const exported = JSON.stringify(name)
      liveReexports += `export { ${exported} } from ${targetImport}\n`
      liveSnapshots += `_[${exported}] = namespace[${exported}]\n`
    }
  }

  for (const payload of target.payloads) {
    const payloadName = `payload${publicationIndex++}`
    publications += `  const ${payloadName} = {
      integration: ${JSON.stringify(payload.integration)},
      module: _,
      moduleName: ${JSON.stringify(payload.moduleName)},
      package: ${JSON.stringify(payload.package)},
      path: ${JSON.stringify(payload.path)},
      version: ${JSON.stringify(payload.version)},
      apply (exports, patchDefault) {
        if (patchDefault) return set.default?.(exports)
        for (const name of Object.keys(exports)) set[name]?.(exports[name])
      },
  }
  channel.publish(${payloadName})
`
  }

  return `/* eslint-disable @stylistic/quotes, @stylistic/semi */
/* eslint-disable dot-notation, import/no-mutable-exports */
/* eslint-disable indent */
import nativeDc from 'node:diagnostics_channel'
import * as namespace from
  ${targetImport}
${liveReexports}const dc = globalThis[Symbol.for(${JSON.stringify(BUNDLER_DC_GLOBAL)})] ?? nativeDc
const _ = Object.create(null, { [Symbol.toStringTag]: { value: 'Module' } })
const set = {}
const get = {}
${liveSnapshots}${target.setters.join(';\n')}
const channel = dc.channel('${CHANNEL}')
if (channel.hasSubscribers) {
${publications}}
`
}

/**
 * @param {Target[]} targets
 * @returns {RegExp|undefined}
 */
function createPackagePathPattern (targets) {
  const packageNames = new Set()
  for (const target of targets) {
    for (const payload of target.payloads) packageNames.add(payload.package)
  }
  return new RegExp(`(?:^|/)node_modules/(?:${createAlternation(packageNames)})(?:/|$)`)
}

/**
 * @param {Array<{ file: string }>} relativeTargets
 * @returns {RegExp|undefined}
 */
function createRelativePathPattern (relativeTargets) {
  if (relativeTargets.length === 0) return
  const files = new Set()
  for (const target of relativeTargets) files.add(target.file)
  return new RegExp(`(?:^|/)(?:${createAlternation(files)})$`)
}

/**
 * @param {Target[]} targets
 * @returns {RegExp}
 */
function createTargetPathPattern (targets) {
  const paths = new Set()
  for (const target of targets) {
    paths.add(target.path)
    for (const rulePath of target.rulePaths) paths.add(rulePath)
  }
  return new RegExp(`(?:^|/)(?:${createAlternation(paths)})$`)
}

/**
 * @param {Set<string>} values
 * @returns {string}
 */
function createAlternation (values) {
  let result = ''
  for (const value of [...values].sort()) {
    if (result) result += '|'
    result += escapeRegExp(value)
  }
  return result
}

/**
 * @param {string} file
 * @param {string} content
 * @returns {Promise<void>}
 */
async function writeArtifact (file, content) {
  try {
    const existing = await fs.readFile(file, 'utf8')
    if (existing === content) return
    throw new Error(`The Datadog Turbopack artifact at ${file} does not match its content address`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const temporaryFile = `${file}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(temporaryFile, content, { flag: 'wx' })
  try {
    await fs.link(temporaryFile, file)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = await fs.readFile(file, 'utf8')
    if (existing !== content) {
      throw new Error(`The Datadog Turbopack artifact at ${file} does not match its content address`)
    }
  } finally {
    try {
      await fs.unlink(temporaryFile)
    } catch (error) {
      warnOnce(
        `cleanup:${temporaryFile}`,
        `Could not remove temporary Turbopack artifact ${temporaryFile}: ${errorMessage(error)}`
      )
    }
  }
}

/**
 * @param {Target} left
 * @param {Target} right
 * @returns {number}
 */
function compareTargets (left, right) {
  return left.path.localeCompare(right.path)
}

/**
 * @param {{ file: string, sourceHash: string }} left
 * @param {{ file: string, sourceHash: string }} right
 * @returns {number}
 */
function compareRelativeTargets (left, right) {
  return left.file.localeCompare(right.file) || left.sourceHash.localeCompare(right.sourceHash)
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
function relativeImport (from, to) {
  return path.relative(from, to).replaceAll('\\', '/')
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizePath (value) {
  return fsSync.realpathSync(value).replaceAll('\\', '/')
}

/**
 * @param {string|Buffer} value
 * @returns {string}
 */
function hash (value) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp (value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

/**
 * @param {string} key
 * @param {string} message
 */
function warnOnce (key, message) {
  if (emittedWarnings.has(key) || emittedWarnings.size >= MAX_WARNINGS) return
  emittedWarnings.add(key)
  process.emitWarning(message, { code: 'DD_TRACE_TURBOPACK' })
}

module.exports = {
  createBuildPlan,
}
