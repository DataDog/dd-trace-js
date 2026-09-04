'use strict'

const { spawnSync } = require('node:child_process')
const { createHash, randomUUID } = require('node:crypto')
const fsSync = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')
const { fileURLToPath, pathToFileURL } = require('node:url')

const { getEnvironmentVariables } = require('../../dd-trace/src/config/helper')
const instrumentations = require('../../datadog-instrumentations/src/helpers/instrumentations')
const hooks = require('../../datadog-instrumentations/src/helpers/hooks')
const {
  filename,
  matchVersion,
} = require('../../datadog-instrumentations/src/helpers/instrumentation-utils')
const { isESMFile, processModule, resolveModule } = require('../../datadog-esbuild/src/utils')
const { parseSource } = require('./compiler')

const CACHE_DIRECTORY = path.join('node_modules', '.cache', 'dd-trace', 'turbopack')
const CHANNEL = 'dd-trace:bundler:load'
const MODULE_SYNTAX_PATTERN = /\b(?:export|import)\b/
const MAX_WARNINGS = 128
const PLAN_VERSION = 6
const RESOLVER_MAX_BUFFER = 1024 * 1024
const SOURCE_MODULE_PATH_PATTERN = /\.(?:js|jsx|ts|tsx)$/
const RESOLVER_SOURCE = `
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk

const results = []
for (const { directory, name } of JSON.parse(input)) {
  const parent = pathToFileURL(resolve(directory, 'package.json'))
  const localRequire = createRequire(parent)
  const entrypoints = new Set()

  try {
    const url = await import.meta.resolve(name, parent)
    if (url.startsWith('file:')) entrypoints.add(fileURLToPath(url))
  } catch {}

  try {
    entrypoints.add(localRequire.resolve(name))
  } catch {}

  if (entrypoints.size === 0) {
    try {
      entrypoints.add(localRequire.resolve('./'))
    } catch {}
  }

  results.push([...entrypoints])
}

process.stdout.write(JSON.stringify(results))
`
const TRAILING_WHITESPACE = /[ \t]+$/gm

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
 * @typedef {object} ExportBinding
 * @property {boolean} [live]
 * @property {string} [name]
 * @property {string} [source]
 */

/**
 * @typedef {object} ModuleAnalysis
 * @property {Map<string, ExportBinding>} bindings
 * @property {string[]} starExports
 */

/**
 * Compiles installed integration targets into immutable build artifacts.
 *
 * @param {string} projectDir
 * @param {{
 *   compiler: { generator: string, parser: string, traverse: string },
 *   discoveryRoot: string
 * }} settings
 * @returns {Promise<{
 *   foreignModuleSyntaxPattern?: RegExp,
 *   moduleSyntaxPattern?: RegExp,
 *   path?: string,
 *   relativePathPattern?: RegExp,
 *   targetPathPattern?: RegExp
 * }>}
 */
async function createBuildPlan (projectDir, settings) {
  projectDir = path.resolve(projectDir)
  loadInstrumentations()

  const dcPolyfill = normalizePath(require.resolve('dc-polyfill'))
  const discoveryRoot = path.resolve(projectDir, settings.discoveryRoot)
  const discoveryRoots = discoveryRoot === projectDir ? [projectDir] : [projectDir, discoveryRoot]
  const targets = getTargets(discoveryRoots)
  const compiledTargets = []
  const esmSpecifiers = new Set()
  let includesEsmTarget = false

  for (const target of targets) {
    try {
      const source = fsSync.readFileSync(target.path)
      const sourceText = source.toString()
      target.sourceHash = hash(source)
      let parsed
      if (target.esm) {
        parsed = parseSource(sourceText, target.path, settings.compiler)
      } else if (SOURCE_MODULE_PATH_PATTERN.test(target.path) && MODULE_SYNTAX_PATTERN.test(sourceText)) {
        try {
          parsed = parseSource(sourceText, target.path, settings.compiler)
          target.esm = parsed.ast.program.sourceType === 'module'
        } catch {
          // Keep the package-derived format when source syntax does not prove ESM.
        }
      }
      if (target.esm) {
        // Export discovery is asynchronous in import-in-the-middle and belongs at build time.
        const moduleSources = new Map([[fileURLToPath(pathToFileURL(target.path)), sourceText]])
        // eslint-disable-next-line no-await-in-loop
        const setters = await processModule({
          path: target.path,
          context: { format: 'module' },
          moduleSources,
        })
        target.liveExports = findLiveExports(
          target.path,
          settings.compiler,
          setters.keys(),
          moduleSources,
          parsed
        )
        target.dependencies = createDependencies(moduleSources, target.path)
        for (const name of target.liveExports) setters.delete(name)
        target.setters = [...setters.values()].map(setter => setter.replaceAll(TRAILING_WHITESPACE, ''))
        for (const payload of target.payloads) esmSpecifiers.add(payload.path)
        includesEsmTarget = true
      }
      compiledTargets.push(target)
    } catch (error) {
      warnOnce(`target:${target.path}`, `Could not instrument ${target.path}: ${String(error?.message ?? error)}`)
    }
  }

  const relativeTargets = getRelativeTargets(compiledTargets)
  if (compiledTargets.length === 0 && relativeTargets.length === 0) return {}

  compiledTargets.sort(comparePaths)
  relativeTargets.sort((left, right) =>
    left.file.localeCompare(right.file) || left.sourceHash.localeCompare(right.sourceHash))
  const artifactDirectory = path.resolve(projectDir, CACHE_DIRECTORY)
  try {
    await fs.mkdir(artifactDirectory, { recursive: true })
  } catch (error) {
    throw new Error(
      `Could not create the Datadog Turbopack cache at ${artifactDirectory}: ${String(error?.message ?? error)}`,
      { cause: error }
    )
  }
  const realArtifactDirectory = normalizePath(artifactDirectory)
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
      const proxy = createEsmProxy(
        /** @type {Target & { setters: string[] }} */ (target),
        path.join(realArtifactDirectory, 'proxy.mjs'),
        dcPolyfill
      )
      const proxyId = hash(proxy)
      const proxyPath = path.join(realArtifactDirectory, `${proxyId}.mjs`)
      // Files are content-addressed and safe for concurrent config evaluation.
      // eslint-disable-next-line no-await-in-loop
      await writeArtifact(proxyPath, proxy)
      entry.proxyPath = normalizePath(proxyPath)
    }

    planTargets[target.path] = entry
  }

  const plan = JSON.stringify({
    compiler: settings.compiler,
    dcPolyfill,
    relativeTargets,
    targets: planTargets,
    version: PLAN_VERSION,
  })
  const planHash = hash(plan)
  const planPath = path.join(realArtifactDirectory, `${planHash}.json`)
  await writeArtifact(planPath, plan)

  return {
    foreignModuleSyntaxPattern: esmSpecifiers.size === 0
      ? undefined
      : new RegExp(`(['"\`])(?:${createAlternation(esmSpecifiers)})\\1`),
    moduleSyntaxPattern: includesEsmTarget ? /\b(?:export|import|require)\b/ : undefined,
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
  dependencies.sort(comparePaths)
  return dependencies
}

/**
 * @param {{ path: string }} left
 * @param {{ path: string }} right
 * @returns {number}
 */
function comparePaths (left, right) {
  return left.path.localeCompare(right.path)
}

/** Loads each instrumentation declaration before target discovery. */
function loadInstrumentations () {
  for (const [name, hook] of Object.entries(hooks)) {
    const declaration = /** @type {Function|{ fn?: Function }} */ (hook)
    const load = typeof declaration === 'function' ? declaration : declaration.fn
    if (typeof load !== 'function') continue

    try {
      load()
    } catch (error) {
      warnOnce(`hook:${name}`, `Could not load the ${name} instrumentation: ${String(error?.message ?? error)}`)
    }
  }
}

/**
 * @param {string[]} discoveryRoots
 * @returns {Target[]}
 */
function getTargets (discoveryRoots) {
  const targets = new Map()
  const packageNames = new Set()

  for (const name of Object.keys(instrumentations)) {
    if (!name.startsWith('node:') && !name.startsWith('.')) packageNames.add(name)
  }

  const packageRootsByName = findPackageRoots(discoveryRoots, packageNames)
  const requests = []
  for (const [name, entries] of Object.entries(instrumentations)) {
    if (name.startsWith('node:') || name.startsWith('.')) continue

    const packageRoots = [...(packageRootsByName.get(name) ?? [])]
    if (packageRoots.length === 0) {
      requests.push({ directory: discoveryRoots[0], entries, name })
      continue
    }

    for (const packageRoot of packageRoots) requests.push({ directory: packageRoot, entries, name, packageRoot })
  }

  let resolutions
  try {
    resolutions = resolvePackageEntrypoints(requests)
  } catch (error) {
    warnOnce('resolve', `Could not resolve Turbopack instrumentation targets: ${String(error?.message ?? error)}`)
    resolutions = requests.map(() => [])
  }

  for (let index = 0; index < requests.length; index++) {
    const { entries, name, packageRoot } = requests[index]
    if (packageRoot) {
      addTargets(targets, packageRoot, name, entries, resolutions[index])
      continue
    }

    const entrypointsByRoot = new Map()
    for (const entrypoint of resolutions[index]) {
      const resolvedPackageRoot = findPackageRoot(entrypoint, name)
      if (!resolvedPackageRoot) continue

      const entrypoints = entrypointsByRoot.get(resolvedPackageRoot) ?? []
      entrypoints.push(entrypoint)
      entrypointsByRoot.set(resolvedPackageRoot, entrypoints)
    }
    for (const [resolvedPackageRoot, entrypoints] of entrypointsByRoot) {
      addTargets(targets, resolvedPackageRoot, name, entries, entrypoints)
    }
  }

  return [...targets.values()]
}

/**
 * @param {Target[]} targets
 * @returns {Array<{ esm: boolean, file: string, payloads: InstrumentationPayload[], sourceHash: string }>}
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
          if (existing && (existing.esm !== target.esm || existing.payloads[0].version !== match.version)) {
            relativeTargets.delete(key)
            ambiguousTargets.add(key)
            continue
          }

          if (existing) continue

          relativeTargets.set(key, {
            esm: target.esm,
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
 * @param {string[]} entrypoints
 */
function addTargets (targets, packageRoot, name, entries, entrypoints) {
  let packageJson
  try {
    packageJson = JSON.parse(fsSync.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  } catch {
    return
  }

  for (const entry of entries) {
    if (!matchVersion(packageJson.version, entry.versions)) continue

    let files
    try {
      if (entry.file) {
        files = [path.join(packageRoot, entry.file)]
      } else if (entry.filePattern) {
        files = findMatchingFiles(packageRoot, new RegExp(entry.filePattern))
      } else {
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

      let payload
      for (const candidate of target.payloads) {
        if (candidate.package === name && candidate.moduleName === moduleName &&
          candidate.version === packageJson.version) {
          payload = candidate
          break
        }
      }
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

// Visit package boundaries only: this reaches nested dependency copies without
// walking each package's source tree during Next configuration.
/**
 * @param {string[]} discoveryRoots
 * @param {Set<string>} names
 * @returns {Map<string, Set<string>>}
 */
function findPackageRoots (discoveryRoots, names) {
  const packageRoots = new Map()
  const pending = discoveryRoots.map(root => path.join(root, 'node_modules'))
  const seen = new Set()

  while (pending.length > 0) {
    const nodeModules = /** @type {string} */ (pending.pop())
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
 * Resolves package entry points in one isolated Node.js process. This uses the
 * runtime's own export-map implementation without running application loaders.
 *
 * @param {Array<{ directory: string, name: string }>} requests
 * @returns {string[][]}
 */
function resolvePackageEntrypoints (requests) {
  if (requests.length === 0) return []

  const env = getEnvironmentVariables()
  delete env.NODE_OPTIONS
  const result = spawnSync(process.execPath, [
    '--no-warnings',
    '--experimental-import-meta-resolve',
    '--input-type=module',
    '--eval',
    RESOLVER_SOURCE,
  ], {
    encoding: 'utf8',
    env,
    input: JSON.stringify(requests.map(({ directory, name }) => ({ directory, name }))),
    maxBuffer: RESOLVER_MAX_BUFFER,
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    const stderr = result.stderr?.trim()
    throw new Error(stderr || `Node.js resolver exited with status ${result.status}`)
  }
  return JSON.parse(/** @type {string} */ (result.stdout))
}

/**
 * @param {string} file
 * @param {string} name
 * @returns {string|void}
 */
function findPackageRoot (file, name) {
  let directory = path.dirname(file)
  while (directory !== path.dirname(directory)) {
    try {
      const packageJson = JSON.parse(fsSync.readFileSync(path.join(directory, 'package.json'), 'utf8'))
      if (packageJson.name === name) return directory
    } catch {}
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
    const current = /** @type {string} */ (pending.pop())
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
 * @param {string} resourcePath
 * @param {{ parser: string, traverse: string }} compiler
 * @param {Iterable<string>} exportNames
 * @param {Map<string, string>} moduleSources
 * @param {{ ast: object, traverse: Function }} parsed
 * @returns {string[]}
 */
function findLiveExports (resourcePath, compiler, exportNames, moduleSources, parsed) {
  const analyses = new Map([[resourcePath, analyzeModule(parsed)]])
  const liveExports = new Set()
  for (const name of exportNames) {
    if (resolveExport(resourcePath, name, compiler, moduleSources, analyses, new Set()).live) {
      liveExports.add(name)
    }
  }
  return [...liveExports].sort()
}

/**
 * @param {{ ast: object, traverse: Function }} parsed
 * @returns {ModuleAnalysis}
 */
function analyzeModule ({ ast, traverse }) {
  const analysis = { bindings: new Map(), starExports: [] }
  traverse(ast, {
    /** @param {object} programPath */
    Program (programPath) {
      for (const statementPath of programPath.get('body')) {
        const { node } = statementPath
        if (statementPath.isExportAllDeclaration()) {
          if (node.exportKind === 'type') continue
          const exported = getExportName(node.exported)
          if (exported === undefined) analysis.starExports.push(node.source.value)
          else analysis.bindings.set(exported, { live: false })
          continue
        }
        if (statementPath.isExportDefaultDeclaration()) {
          const name = node.declaration.id?.name
          analysis.bindings.set('default', {
            live: name !== undefined && programPath.scope.getBinding(name)?.constant === false,
          })
          continue
        }
        if (!statementPath.isExportNamedDeclaration() || node.exportKind === 'type') continue

        const declarationPath = statementPath.get('declaration')
        if (declarationPath.node) {
          for (const name of Object.keys(declarationPath.getBindingIdentifiers())) {
            analysis.bindings.set(name, {
              live: programPath.scope.getBinding(name)?.constant === false,
            })
          }
        }

        for (const specifier of node.specifiers) {
          if (specifier.exportKind === 'type') continue
          const exported = getExportName(specifier.exported)
          if (exported === undefined) continue

          if (node.source) {
            const name = getExportName(specifier.local)
            analysis.bindings.set(exported, name === undefined
              ? { live: false }
              : { name, source: node.source.value })
            continue
          }

          const local = getExportName(specifier.local)
          analysis.bindings.set(exported, getLocalBinding(programPath, local))
        }
      }
    },
  })
  return analysis
}

/**
 * @param {object} programPath
 * @param {string|undefined} name
 * @returns {ExportBinding}
 */
function getLocalBinding (programPath, name) {
  if (name === undefined) return { live: false }
  const binding = programPath.scope.getBinding(name)
  if (!binding || binding.kind !== 'module') return { live: binding?.constant === false }

  const { node, parentPath } = binding.path
  const source = parentPath?.node?.source?.value
  if (typeof source !== 'string') return { live: false }
  if (node.type === 'ImportDefaultSpecifier') return { name: 'default', source }
  if (node.type !== 'ImportSpecifier') return { live: false }

  const imported = getExportName(node.imported)
  return imported === undefined ? { live: false } : { name: imported, source }
}

/**
 * @param {string} resourcePath
 * @param {string} name
 * @param {{ parser: string, traverse: string }} compiler
 * @param {Map<string, string>} moduleSources
 * @param {Map<string, ModuleAnalysis>} analyses
 * @param {Set<string>} pending
 * @returns {{ found: boolean, live: boolean }}
 */
function resolveExport (resourcePath, name, compiler, moduleSources, analyses, pending) {
  const key = `${resourcePath}\0${name}`
  if (pending.has(key)) return { found: false, live: false }
  pending.add(key)

  const analysis = getModuleAnalysis(resourcePath, compiler, moduleSources, analyses)
  if (!analysis) {
    pending.delete(key)
    return { found: false, live: false }
  }

  const binding = analysis.bindings.get(name)
  if (binding) {
    let result = { found: true, live: binding.live === true }
    if (binding.source !== undefined && binding.name !== undefined) {
      const dependencyPath = resolveExportPath(resourcePath, binding.source)
      if (dependencyPath !== undefined) {
        result = resolveExport(dependencyPath, binding.name, compiler, moduleSources, analyses, pending)
      }
    }
    pending.delete(key)
    return result
  }

  if (name !== 'default') {
    for (const specifier of analysis.starExports) {
      const dependencyPath = resolveExportPath(resourcePath, specifier)
      if (dependencyPath === undefined) continue
      const result = resolveExport(dependencyPath, name, compiler, moduleSources, analyses, pending)
      if (result.found) {
        pending.delete(key)
        return result
      }
    }
  }

  pending.delete(key)
  return { found: false, live: false }
}

/**
 * @param {string} resourcePath
 * @param {{ parser: string, traverse: string }} compiler
 * @param {Map<string, string>} moduleSources
 * @param {Map<string, ModuleAnalysis>} analyses
 * @returns {ModuleAnalysis|undefined}
 */
function getModuleAnalysis (resourcePath, compiler, moduleSources, analyses) {
  const existing = analyses.get(resourcePath)
  if (existing) return existing

  try {
    let source = moduleSources.get(resourcePath)
    if (source === undefined) {
      source = fsSync.readFileSync(resourcePath, 'utf8')
      moduleSources.set(resourcePath, source)
    }
    const analysis = analyzeModule(parseSource(source, resourcePath, compiler))
    analyses.set(resourcePath, analysis)
    return analysis
  } catch {
    // An unparseable dependency is not proven mutable, so retain its patch setter.
  }
}

/**
 * @param {string} resourcePath
 * @param {string} specifier
 * @returns {string|undefined}
 */
function resolveExportPath (resourcePath, specifier) {
  try {
    const parentURL = pathToFileURL(resourcePath)
    const request = specifier.startsWith('.') ? new URL(specifier, parentURL).href : specifier
    const { url } = resolveModule(request, { parentURL })
    return normalizePath(fileURLToPath(url))
  } catch {
    // An unresolved dependency is not proven mutable, so retain its patch setter.
  }
}

/**
 * @param {{ name?: string, value?: string }|undefined} exported
 * @returns {string|undefined}
 */
function getExportName (exported) {
  return exported?.name ?? exported?.value
}

/**
 * @param {Target & { setters: string[] }} target
 * @param {string} proxyPath
 * @param {string} dcPolyfill
 * @returns {string}
 */
function createEsmProxy (target, proxyPath, dcPolyfill) {
  const targetImport = JSON.stringify(relativeImport(path.dirname(proxyPath), target.path))
  const dcImport = JSON.stringify(relativeImport(path.dirname(proxyPath), dcPolyfill))
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

  return `/* eslint-disable @stylistic/max-len, @stylistic/quotes, @stylistic/semi */
/* eslint-disable dot-notation, import/no-mutable-exports, import/no-useless-path-segments */
/* eslint-disable indent */
/* eslint-disable unicorn/prefer-identifier-import-export-specifiers */
import dc from ${dcImport}
import * as namespace from
  ${targetImport}
${liveReexports}
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
        `Could not remove temporary Turbopack artifact ${temporaryFile}: ${String(error?.message ?? error)}`
      )
    }
  }
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
