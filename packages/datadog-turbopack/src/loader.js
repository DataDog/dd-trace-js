'use strict'

const { createHash } = require('node:crypto')
const fs = require('node:fs')
const { builtinModules } = require('node:module')
const path = require('node:path')
const { fileURLToPath } = require('node:url')

const { createBundlerRewriter } = require('../../datadog-instrumentations/src/helpers/rewriter/bundler')
const { parseSource } = require('./compiler')

const BUILTIN_MODULES = new Set(builtinModules)
const CHANNEL = 'dd-trace:bundler:load'
const IMPORT_RESOLVE_OPTIONS = { conditionNames: ['...', 'node', 'import'] }
// Instrumentation targets currently span at most six path depths. This bound leaves room for deeply nested
// workspaces while preventing untrusted project layouts from retaining matchers for the process lifetime.
const MAX_BUNDLER_REWRITERS = 64
const MAX_CACHED_FILES = 2048
const MAX_WARNINGS = 128
const MODULE_SYNTAX_PATTERN = /\b(?:export|import|require)\b/
const PLAN_VERSION = 7
const PROXY_FILENAME_PATTERN = /^[a-f\d]{64}\.mjs$/
const REQUIRE_RESOLVE_OPTIONS = { conditionNames: ['...', 'node', 'require'] }

/** @type {Map<string, { ctimeMs: number, hash: string, mtimeMs: number, size: number }>} */
const fileHashes = new Map()
let cachedManifestPath
/** @type {BuildContext|undefined} */
let cachedBuildContext
/** @type {Set<string>} */
const warnedErrors = new Set()

/**
 * @typedef {object} PlanTarget
 * @property {boolean} esm
 * @property {Array<{ path: string, sourceHash: string }>} [dependencies]
 * @property {object[]} payloads
 * @property {string} [proxyPath]
 * @property {{ moduleName: string, filePath: string }} [rewriteTarget]
 * @property {string} sourceHash
 */

/**
 * @typedef {object} BuildPlan
 * @property {{ generator: string, parser: string, traverse: string }} compiler
 * @property {Record<string, string>} components
 * @property {string} dcPolyfill
 * @property {Array<{ path: string, sourceHash: string }>} graphDependencies
 * @property {Array<PlanTarget & { file: string }>} relativeTargets
 * @property {Record<string, PlanTarget>} targets
 * @property {number} version
 */

/**
 * @typedef {object} BuildContext
 * @property {BuildPlan} plan
 * @property {Map<string, BundlerRewriter>} rewriters
 *
 * @typedef {(content: string|Buffer|ArrayBuffer|Uint8Array, filename: string, format?: string,
 *   target?: { moduleName: string, filePath: string }, sourceMap?: string|object) =>
 *   { code: string|Buffer|ArrayBuffer|Uint8Array, map?: string|object }} BundlerRewriter
 */

/**
 * @typedef {object} LoaderContext
 * @property {Function} async
 * @property {(warning: Error) => void} [emitWarning]
 * @property {Function} getOptions
 * @property {Function} getResolve
 * @property {string} resourcePath
 */

/**
 * @typedef {object} ModuleEdge
 * @property {'import'|'require'} kind
 * @property {object[]} nodes
 * @property {string} specifier
 */

/**
 * @typedef {object} CollectState
 * @property {Map<string, ModuleEdge>} edges
 */

/**
 * Instruments modules selected by a build plan generated from the installed
 * dd-trace integrations.
 *
 * @this {LoaderContext}
 * @param {string} source
 * @param {object} [inputSourceMap]
 * @returns {void}
 */
module.exports = function loader (source, inputSourceMap) {
  const callback = this.async()
  load.call(this, source, inputSourceMap).then(
    ({ code, map }) => callback(undefined, code, map),
    error => callback(error)
  )
}

/**
 * @this {LoaderContext}
 * @param {string} source
 * @param {object|undefined} inputSourceMap
 * @returns {Promise<{ code: string, map?: object }>}
 */
async function load (source, inputSourceMap) {
  const options = this.getOptions()
  const buildContext = getBuildContext(options.manifestPath)
  const { plan } = buildContext
  const resourcePath = fs.realpathSync(this.resourcePath).replaceAll('\\', '/')
  const match = findTarget(resourcePath, plan, options.targetScope, this)
  const esm = match?.esm ?? false
  const sourceType = match ? (esm ? 'module' : 'commonjs') : 'unambiguous'

  if (path.dirname(resourcePath) === path.dirname(options.manifestPath) &&
    PROXY_FILENAME_PATTERN.test(path.basename(resourcePath)) ||
    !options.rewriteEdges || !MODULE_SYNTAX_PATTERN.test(source)) {
    return finishLoad(source, inputSourceMap, resourcePath, match, esm, buildContext)
  }

  const changedGraphPath = findChangedDependency(plan.graphDependencies)
  if (changedGraphPath) {
    warnOnce(
      this,
      `changed:${changedGraphPath}`,
      `Skipped changed dependency ${changedGraphPath}`
    )
    return finishLoad(source, inputSourceMap, resourcePath, match, esm, buildContext)
  }

  const rewritten = await rewriteModuleEdges(
    source,
    inputSourceMap,
    resourcePath,
    plan,
    this,
    sourceType
  )
  return finishLoad(rewritten.code, rewritten.map, resourcePath, match, esm, buildContext)
}

/**
 * @param {string} manifestPath
 * @returns {BuildContext}
 */
function getBuildContext (manifestPath) {
  if (typeof manifestPath !== 'string') {
    throw new TypeError('The Datadog Turbopack loader requires a build plan path')
  }

  if (manifestPath === cachedManifestPath && cachedBuildContext) return cachedBuildContext

  const serialized = fs.readFileSync(manifestPath, 'utf8')
  const manifestHash = path.basename(manifestPath, '.json')
  if (createHash('sha256').update(serialized).digest('hex') !== manifestHash) {
    throw new Error(`The Datadog Turbopack build plan at ${manifestPath} failed its integrity check`)
  }

  const plan = /** @type {BuildPlan} */ (JSON.parse(serialized))
  if (plan?.version !== PLAN_VERSION || typeof plan.compiler?.generator !== 'string' ||
    typeof plan.compiler.parser !== 'string' || typeof plan.compiler.traverse !== 'string' ||
    !plan.components || typeof plan.components !== 'object' || Array.isArray(plan.components) ||
    typeof plan.dcPolyfill !== 'string' ||
    !Array.isArray(plan.graphDependencies) ||
    !Array.isArray(plan.relativeTargets) ||
    !plan.targets || typeof plan.targets !== 'object' || Array.isArray(plan.targets)) {
    throw new Error(`The Datadog Turbopack build plan at ${manifestPath} is not supported`)
  }

  cachedManifestPath = manifestPath
  cachedBuildContext = {
    plan,
    rewriters: new Map(),
  }
  return cachedBuildContext
}

/**
 * @param {string} resourcePath
 * @param {BuildPlan} plan
 * @param {'direct'|'relative'|undefined} targetScope
 * @param {{ emitWarning?: (warning: Error) => void }} loaderContext
 * @returns {PlanTarget|void}
 */
function findTarget (resourcePath, plan, targetScope, loaderContext) {
  const direct = plan.targets[resourcePath]
  if (targetScope === 'direct') {
    if (!direct) return
    const changedPath = findChangedSource(resourcePath, direct)
    if (!changedPath) return direct
    warnOnce(loaderContext, `changed:${changedPath}`, `Skipped changed dependency ${changedPath}`)
    return
  }
  if (targetScope !== 'relative' || direct) return

  let sourceHash
  for (const target of plan.relativeTargets) {
    if (!resourcePath.endsWith(`/${target.file}`)) continue
    sourceHash ??= getFileHash(resourcePath)
    if (sourceHash !== target.sourceHash) continue
    return target
  }
}

/**
 * @param {string} source
 * @param {object|undefined} inputSourceMap
 * @param {string} resourcePath
 * @param {BuildPlan} plan
 * @param {{ emitWarning?: (warning: Error) => void, getResolve: Function }} loaderContext
 * @param {'commonjs'|'module'|'unambiguous'} sourceType
 * @returns {Promise<{ code: string, map?: object }>}
 */
async function rewriteModuleEdges (
  source,
  inputSourceMap,
  resourcePath,
  plan,
  loaderContext,
  sourceType
) {
  const { compiler, components, targets } = plan
  const directory = path.dirname(resourcePath)
  const state = { edges: new Map() }
  let parsed
  try {
    parsed = parseSource(source, resourcePath, compiler, sourceType)
  } catch (error) {
    if (sourceType !== 'unambiguous') throw error
    parsed = parseSource(source, resourcePath, compiler, 'commonjs')
  }
  const { ast, traverse } = parsed
  const generate = require(compiler.generator).default
  traverse(ast, IMPORT_VISITORS, undefined, state)

  if (state.edges.size === 0) return { code: source, map: inputSourceMap }

  const importResolve = loaderContext.getResolve(IMPORT_RESOLVE_OPTIONS)
  const requireResolve = loaderContext.getResolve(REQUIRE_RESOLVE_OPTIONS)

  const resolutions = []
  for (const edge of state.edges.values()) {
    const resolver = edge.kind === 'require' ? requireResolve : importResolve
    resolutions.push(new Promise(resolve => {
      resolver(directory, edge.specifier, (error, resolved) => {
        resolve(error ? undefined : resolved)
      })
    }))
  }
  const resolvedEdges = await Promise.all(resolutions)
  let rewritten = false
  let index = 0
  for (const edge of state.edges.values()) {
    const resolved = resolvedEdges[index++]
    if (resolved) {
      rewritten = rewriteResolvedEdge(edge, resolved, resourcePath, components, targets, loaderContext) || rewritten
    }
  }
  if (!rewritten) return { code: source, map: inputSourceMap }

  const { code, map } = generate(ast, {
    inputSourceMap,
    retainLines: true,
    sourceFileName: resourcePath,
    sourceMaps: true,
  }, source)
  return { code, map }
}

/**
 * @param {{ node: object }} modulePath
 * @param {CollectState} state
 */
function collectModuleDeclaration (modulePath, state) {
  if (isTypeOnlyDeclaration(modulePath.node)) return
  collectModuleSource(modulePath.node.source, 'import', state)
}

/**
 * @param {{ node: { arguments: object[], callee?: object }, scope: { hasBinding: Function } }} modulePath
 * @param {CollectState} state
 */
function collectCallExpression (modulePath, state) {
  const { arguments: args, callee } = modulePath.node
  if (callee?.type === 'Import' && args?.length > 0) {
    collectModuleSource(args[0], 'import', state)
    return
  }
  if (callee?.type === 'Identifier' && callee.name === 'require' && args?.length === 1 &&
    !modulePath.scope.hasBinding('require', true)) {
    collectModuleSource(args[0], 'require', state)
  }
}

/**
 * @param {{ node: { source?: object } }} modulePath
 * @param {CollectState} state
 */
function collectImportExpression (modulePath, state) {
  collectModuleSource(modulePath.node.source, 'import', state)
}

/**
 * @param {{ node: { importKind?: string, moduleReference?: { expression?: object, type?: string } } }} modulePath
 * @param {CollectState} state
 */
function collectTypescriptImport (modulePath, state) {
  const { importKind, moduleReference } = modulePath.node
  if (importKind === 'type' || moduleReference?.type !== 'TSExternalModuleReference') return
  collectModuleSource(moduleReference.expression, 'require', state)
}

/**
 * @param {object|undefined} moduleSource
 * @param {'import'|'require'} kind
 * @param {CollectState} state
 */
function collectModuleSource (moduleSource, kind, state) {
  const specifier = getModuleSpecifier(moduleSource)
  if (specifier === undefined || specifier.startsWith('node:') || BUILTIN_MODULES.has(specifier)) return

  const key = `${kind}\0${specifier}`
  const existing = state.edges.get(key)
  if (existing) {
    existing.nodes.push(moduleSource)
    return
  }
  state.edges.set(key, { kind, nodes: [moduleSource], specifier })
}

/**
 * @param {object|undefined} moduleSource
 * @returns {string|void}
 */
function getModuleSpecifier (moduleSource) {
  if (moduleSource?.type === 'StringLiteral') return moduleSource.value
  if (moduleSource?.type === 'TemplateLiteral' && moduleSource.expressions.length === 0) {
    return moduleSource.quasis[0].value.cooked
  }
}

/**
 * @param {object} declaration
 * @returns {boolean}
 */
function isTypeOnlyDeclaration (declaration) {
  if (declaration.importKind === 'type' || declaration.importKind === 'typeof' ||
    declaration.exportKind === 'type') return true
  const typeKind = declaration.type === 'ImportDeclaration' ? 'importKind' : 'exportKind'
  if ((declaration.type !== 'ImportDeclaration' && declaration.type !== 'ExportNamedDeclaration') ||
    declaration.specifiers.length === 0) return false
  for (const specifier of declaration.specifiers) {
    if (specifier[typeKind] !== 'type' && specifier[typeKind] !== 'typeof') return false
  }
  return true
}

const IMPORT_VISITORS = {
  CallExpression: collectCallExpression,
  ExportAllDeclaration: collectModuleDeclaration,
  ExportNamedDeclaration: collectModuleDeclaration,
  ImportDeclaration: collectModuleDeclaration,
  ImportExpression: collectImportExpression,
  TSImportEqualsDeclaration: collectTypescriptImport,
}

/**
 * @param {ModuleEdge} edge
 * @param {string} resolved
 * @param {string} resourcePath
 * @param {Record<string, string>} components
 * @param {Record<string, PlanTarget>} targets
 * @param {{ emitWarning?: (warning: Error) => void }} loaderContext
 * @returns {boolean}
 */
function rewriteResolvedEdge (edge, resolved, resourcePath, components, targets, loaderContext) {
  const plainPath = getPlainResolvedPath(resolved)
  if (!plainPath) return false
  const resolvedPath = fs.realpathSync(plainPath).replaceAll('\\', '/')
  const target = targets[resolvedPath]
  if (!target?.esm || !target.proxyPath) return false
  if (components?.[resourcePath] !== undefined && components[resourcePath] === components[resolvedPath]) return false
  const changedPath = findChangedSource(resolvedPath, target)
  if (changedPath) {
    warnOnce(loaderContext, `changed:${changedPath}`, `Skipped changed dependency ${changedPath}`)
    return false
  }

  const replacement = relativeImport(path.dirname(resourcePath), target.proxyPath)
  for (const node of edge.nodes) setModuleSpecifier(node, replacement)
  return true
}

/**
 * @param {string} resolved
 * @returns {string|void}
 */
function getPlainResolvedPath (resolved) {
  if (typeof resolved !== 'string') return

  if (resolved.startsWith('file:')) {
    if (resolved.includes('?') || resolved.includes('#')) return
    try {
      return fileURLToPath(resolved)
    } catch {
      return
    }
  }

  if (!path.isAbsolute(resolved) || resolved.includes('?') || resolved.includes('#') || resolved.includes('!')) return
  return resolved
}

/**
 * @param {string} resourcePath
 * @param {PlanTarget} target
 * @returns {string|void}
 */
function findChangedSource (resourcePath, target) {
  if (getFileHash(resourcePath) !== target.sourceHash) return resourcePath
  if (target.dependencies) {
    for (const dependency of target.dependencies) {
      if (getFileHash(dependency.path) !== dependency.sourceHash) return dependency.path
    }
  }
}

/**
 * @param {Array<{ path: string, sourceHash: string }>} dependencies
 * @returns {string|undefined}
 */
function findChangedDependency (dependencies) {
  for (const dependency of dependencies) {
    try {
      if (getFileHash(dependency.path) !== dependency.sourceHash) return dependency.path
    } catch {
      return dependency.path
    }
  }
}

/**
 * @param {object} moduleSource
 * @param {string} value
 */
function setModuleSpecifier (moduleSource, value) {
  if (moduleSource.type === 'StringLiteral') {
    moduleSource.value = value
    moduleSource.extra = undefined
    return
  }

  const templateValue = moduleSource.quasis[0].value
  templateValue.cooked = value
  templateValue.raw = value
    .replaceAll('\\', '\\\\')
    .replaceAll('`', '\\`')
    .replaceAll('${', '\\${')
}

/**
 * @param {string} source
 * @param {object|undefined} sourceMap
 * @param {string} resourcePath
 * @param {PlanTarget|void} match
 * @param {boolean} esm
 * @param {BuildContext} buildContext
 * @returns {{ code: string, map?: object }}
 */
function finishLoad (source, sourceMap, resourcePath, match, esm, buildContext) {
  if (!match) return { code: source, map: sourceMap }

  const dcModule = relativeImport(path.dirname(resourcePath), buildContext.plan.dcPolyfill)
  let rewritten = { code: source, map: sourceMap }
  if (match.rewriteTarget) {
    const rewriter = getBundlerRewriter(buildContext.rewriters, dcModule)
    rewritten = /** @type {{ code: string, map?: object }} */ (rewriter(
      source,
      resourcePath,
      esm ? 'module' : 'commonjs',
      match.rewriteTarget,
      sourceMap
    ))
  }
  const code = esm ? rewritten.code : appendCommonJsPublications(rewritten.code, match, dcModule)
  return { code, map: rewritten.map }
}

/**
 * @param {Map<string, BundlerRewriter>} rewriters
 * @param {string} dcModule
 * @returns {BundlerRewriter}
 */
function getBundlerRewriter (rewriters, dcModule) {
  const cached = rewriters.get(dcModule)
  if (cached) {
    rewriters.delete(dcModule)
    rewriters.set(dcModule, cached)
    return cached
  }

  if (rewriters.size === MAX_BUNDLER_REWRITERS) {
    rewriters.delete(/** @type {string} */ (rewriters.keys().next().value))
  }

  const rewriter = createBundlerRewriter(dcModule)
  rewriters.set(dcModule, rewriter)
  return rewriter
}

/**
 * @param {string} source
 * @param {{ payloads: object[] }} match
 * @param {string} dcModule
 * @returns {string}
 */
function appendCommonJsPublications (source, match, dcModule) {
  let publications = ''
  let publicationIndex = 0

  for (const payload of match.payloads) {
    const payloadName = `payload${publicationIndex++}`
    publications += `    const ${payloadName} = {
      integration: ${JSON.stringify(payload.integration)},
      module: module.exports,
      moduleName: ${JSON.stringify(payload.moduleName)},
      package: ${JSON.stringify(payload.package)},
      path: ${JSON.stringify(payload.path)},
      version: ${JSON.stringify(payload.version)},
    }
    channel.publish(${payloadName})
    module.exports = ${payloadName}.module
`
  }

  return `${source}
{
  /* eslint-disable @stylistic/max-len, @stylistic/quotes */
  const dc = require(${JSON.stringify(dcModule)})
  const channel = dc.channel('${CHANNEL}')
  if (channel.hasSubscribers) {
${publications}  }
}
`
}

/**
 * @param {string} file
 * @returns {string}
 */
function getFileHash (file) {
  const { ctimeMs, mtimeMs, size } = fs.statSync(file)
  const cached = fileHashes.get(file)
  if (cached?.ctimeMs === ctimeMs && cached.mtimeMs === mtimeMs && cached.size === size) return cached.hash

  const value = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  if (fileHashes.size >= MAX_CACHED_FILES) {
    fileHashes.delete(/** @type {string} */ (fileHashes.keys().next().value))
  }
  fileHashes.set(file, { ctimeMs, hash: value, mtimeMs, size })
  return value
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
function relativeImport (from, to) {
  let value = path.relative(from, to).replaceAll('\\', '/')
  if (!value.startsWith('.')) value = `./${value}`
  return value
}

/**
 * @param {{ emitWarning?: (warning: Error) => void }} loaderContext
 * @param {string} key
 * @param {string} message
 * @param {Error} [cause]
 */
function warnOnce (loaderContext, key, message, cause) {
  if (warnedErrors.has(key) || warnedErrors.size >= MAX_WARNINGS) return
  warnedErrors.add(key)
  const warning = new Error(message, { cause })
  warning.name = 'DatadogTurbopackWarning'
  if (typeof loaderContext.emitWarning === 'function') {
    loaderContext.emitWarning(warning)
  } else {
    process.emitWarning(warning)
  }
}
