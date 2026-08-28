'use strict'

const { createHash } = require('node:crypto')
const fs = require('node:fs')
const { builtinModules } = require('node:module')
const path = require('node:path')

const { BUNDLER_DC_GLOBAL } = require('../../datadog-instrumentations/src/helpers/bundler-constants')
const { isESMFile } = require('../../datadog-esbuild/src/utils')
const { rewriteBundledWithSourceMap } = require('../../datadog-instrumentations/src/helpers/rewriter')

const BUILTIN_MODULES = new Set(builtinModules)
const CHANNEL = 'dd-trace:bundler:load'
const IMPORT_RESOLVE_OPTIONS = { conditionNames: ['node', 'import'] }
const BASE_PARSER_PLUGINS = [
  'decorators-legacy',
  'explicitResourceManagement',
  'importAttributes',
  'jsx',
]
const JAVASCRIPT_PARSER_PLUGINS = [...BASE_PARSER_PLUGINS, 'flow']
const MAX_CACHED_FILES = 2048
const MAX_CACHED_PLANS = 16
const MAX_WARNINGS = 128
const MODULE_SYNTAX_PATTERN = /\b(?:export|import|require)\b/
const PLAN_VERSION = 3
const REQUIRE_RESOLVE_OPTIONS = { conditionNames: ['node', 'require'] }
const TYPESCRIPT_PARSER_PLUGINS = [...BASE_PARSER_PLUGINS, 'typescript']

/** @type {Map<string, { ctimeMs: number, hash: string, mtimeMs: number, size: number }>} */
const fileHashes = new Map()
/** @type {Map<string, BuildPlan>} */
const plans = new Map()
/** @type {Set<string>} */
const warnedErrors = new Set()

/**
 * @typedef {object} PlanTarget
 * @property {boolean} esm
 * @property {object[]} payloads
 * @property {string} [proxyPath]
 * @property {string} sourceHash
 */

/**
 * @typedef {object} BuildPlan
 * @property {Record<string, boolean>} proxies
 * @property {Array<PlanTarget & { file: string }>} relativeTargets
 * @property {Record<string, PlanTarget>} targets
 * @property {number} version
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
 * @typedef {object} ResolutionState
 * @property {object} ast
 * @property {(code: string, sourceMap?: object) => void} callback
 * @property {Function} generate
 * @property {object} [inputSourceMap]
 * @property {{ emitWarning?: (warning: Error) => void }} loaderContext
 * @property {number} pending
 * @property {string} resourcePath
 * @property {boolean} rewritten
 * @property {string} source
 * @property {Record<string, PlanTarget>} targets
 */

/**
 * Instruments modules selected by a build plan generated from the installed
 * dd-trace integrations.
 *
 * @param {string} source
 * @param {object} [inputSourceMap]
 * @returns {void}
 */
module.exports = function loader (source, inputSourceMap) {
  const callback = this.async()
  try {
    load.call(this, source, inputSourceMap, callback)
  } catch (error) {
    callback(error)
  }
}

/**
 * @this {{
 *   async: Function,
 *   emitWarning?: (warning: Error) => void,
 *   getOptions: Function,
 *   getResolve: Function,
 *   resourcePath: string
 * }}
 * @param {string} source
 * @param {object} [inputSourceMap]
 * @param {(error?: Error, code?: string, sourceMap?: object) => void} callback
 */
function load (source, inputSourceMap, callback) {
  const options = this.getOptions()
  const plan = getPlan(options.manifestPath, options.manifestHash)
  const resourcePath = normalizePath(this.resourcePath)
  const esm = isESMFile(resourcePath)
  const match = findTarget(resourcePath, plan, options.targetScope, this)

  /**
   * @param {string} code
   * @param {object} [sourceMap]
   */
  function onRewritten (code, sourceMap) {
    finishLoad(code, sourceMap, resourcePath, match, esm, callback)
  }

  if (plan.proxies[resourcePath] || !options.rewriteEdges || !MODULE_SYNTAX_PATTERN.test(source)) {
    onRewritten(source, inputSourceMap)
    return
  }

  rewriteModuleEdges(source, inputSourceMap, resourcePath, plan.targets, options.compiler, this, onRewritten)
}

/**
 * @param {string} manifestPath
 * @param {string} manifestHash
 * @returns {BuildPlan}
 */
function getPlan (manifestPath, manifestHash) {
  if (typeof manifestPath !== 'string' || typeof manifestHash !== 'string') {
    throw new TypeError('The Datadog Turbopack loader requires a build plan path and hash')
  }

  const key = `${manifestPath}\0${manifestHash}`
  const cached = plans.get(key)
  if (cached) return cached

  const serialized = fs.readFileSync(manifestPath, 'utf8')
  if (hash(serialized) !== manifestHash) {
    throw new Error(`The Datadog Turbopack build plan at ${manifestPath} failed its integrity check`)
  }

  const plan = JSON.parse(serialized)
  if (plan?.version !== PLAN_VERSION || !plan.proxies || typeof plan.proxies !== 'object' ||
    Array.isArray(plan.proxies) || !Array.isArray(plan.relativeTargets) ||
    !plan.targets || typeof plan.targets !== 'object') {
    throw new Error(`The Datadog Turbopack build plan at ${manifestPath} is not supported`)
  }

  if (plans.size >= MAX_CACHED_PLANS) plans.delete(plans.keys().next().value)
  plans.set(key, plan)
  return plan
}

/**
 * @param {string} resourcePath
 * @param {BuildPlan} plan
 * @param {'direct'|'relative'} [targetScope]
 * @param {{ emitWarning?: (warning: Error) => void }} loaderContext
 * @returns {PlanTarget|undefined}
 */
function findTarget (resourcePath, plan, targetScope, loaderContext) {
  const direct = plan.targets[resourcePath]
  if (targetScope === 'direct') {
    if (!direct) return
    if (matchesSource(resourcePath, direct.sourceHash)) return direct
    warnOnce(loaderContext, `changed:${resourcePath}`, `Skipped changed dependency ${resourcePath}`)
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
 * @param {object} [inputSourceMap]
 * @param {string} resourcePath
 * @param {Record<string, PlanTarget>} targets
 * @param {{ generator: string, parser: string, traverse: string }} compiler
 * @param {{ emitWarning?: (warning: Error) => void, getResolve: Function }} loaderContext
 * @param {(code: string, sourceMap?: object) => void} callback
 */
function rewriteModuleEdges (source, inputSourceMap, resourcePath, targets, compiler, loaderContext, callback) {
  let ast
  let generate
  const state = { edges: new Map() }

  try {
    const { parse } = require(compiler.parser)
    const traverse = require(compiler.traverse).default
    generate = require(compiler.generator).default
    const plugins = /\.(?:cts|mts|ts|tsx)$/.test(resourcePath)
      ? TYPESCRIPT_PARSER_PLUGINS
      : JAVASCRIPT_PARSER_PLUGINS
    ast = parse(source, { plugins, sourceType: 'unambiguous' })
    traverse(ast, IMPORT_VISITORS, undefined, state)
  } catch (error) {
    warnOnce(
      loaderContext,
      `imports:${resourcePath}`,
      `Could not inspect imports in ${resourcePath}: ${error.message}`,
      error
    )
    callback(source, inputSourceMap)
    return
  }

  if (state.edges.size === 0) {
    callback(source, inputSourceMap)
    return
  }

  resolveModuleEdges(
    state.edges,
    source,
    inputSourceMap,
    resourcePath,
    targets,
    ast,
    generate,
    loaderContext,
    callback
  )
}

/**
 * @param {Map<string, ModuleEdge>} edges
 * @param {string} source
 * @param {object} inputSourceMap
 * @param {string} resourcePath
 * @param {Record<string, PlanTarget>} targets
 * @param {object} ast
 * @param {Function} generate
 * @param {{ emitWarning?: (warning: Error) => void, getResolve: Function }} loaderContext
 * @param {(code: string, sourceMap?: object) => void} callback
 */
function resolveModuleEdges (
  edges,
  source,
  inputSourceMap,
  resourcePath,
  targets,
  ast,
  generate,
  loaderContext,
  callback
) {
  let importResolve
  let requireResolve
  try {
    importResolve = loaderContext.getResolve(IMPORT_RESOLVE_OPTIONS)
    requireResolve = loaderContext.getResolve(REQUIRE_RESOLVE_OPTIONS)
  } catch (error) {
    warnOnce(
      loaderContext,
      `resolver:${resourcePath}`,
      `Could not initialize import resolution in ${resourcePath}: ${error.message}`,
      error
    )
    callback(source, inputSourceMap)
    return
  }

  const state = {
    ast,
    callback,
    generate,
    inputSourceMap,
    loaderContext,
    pending: edges.size,
    resourcePath,
    rewritten: false,
    source,
    targets,
  }
  const directory = path.dirname(resourcePath)
  for (const edge of edges.values()) {
    resolveModuleEdge(edge.kind === 'require' ? requireResolve : importResolve, directory, edge, state)
  }
}

/**
 * @param {Function} resolve
 * @param {string} directory
 * @param {ModuleEdge} edge
 * @param {ResolutionState} state
 */
function resolveModuleEdge (resolve, directory, edge, state) {
  let settled = false

  /**
   * @param {Error|null|undefined} error
   * @param {string} [resolved]
   */
  function onResolved (error, resolved) {
    if (settled) return
    settled = true
    if (!error && resolved) {
      state.rewritten = rewriteResolvedEdge(
        edge,
        resolved,
        state.resourcePath,
        state.targets,
        state.loaderContext
      ) || state.rewritten
    }
    completeModuleEdge(state)
  }

  try {
    resolve(directory, edge.specifier, onResolved)
  } catch (error) {
    onResolved(error)
  }
}

/**
 * @param {ResolutionState} state
 */
function completeModuleEdge (state) {
  state.pending--
  if (state.pending > 0) return
  if (!state.rewritten) {
    state.callback(state.source, state.inputSourceMap)
    return
  }

  try {
    const { code, map } = state.generate(state.ast, {
      inputSourceMap: state.inputSourceMap,
      retainLines: true,
      sourceFileName: state.resourcePath,
      sourceMaps: true,
    }, state.source)
    state.callback(code, map)
  } catch (error) {
    warnOnce(
      state.loaderContext,
      `generate:${state.resourcePath}`,
      `Could not generate rewritten imports in ${state.resourcePath}: ${error.message}`,
      error
    )
    state.callback(state.source, state.inputSourceMap)
  }
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
 * @param {{ node: { arguments?: object[], callee?: object }, scope: { hasBinding: Function } }} modulePath
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
 * @returns {string|undefined}
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
 * @param {Record<string, PlanTarget>} targets
 * @param {{ emitWarning?: (warning: Error) => void }} loaderContext
 * @returns {boolean}
 */
function rewriteResolvedEdge (edge, resolved, resourcePath, targets, loaderContext) {
  let resolvedPath
  try {
    resolvedPath = normalizePath(resolved)
  } catch {
    return false
  }

  const target = targets[resolvedPath]
  if (!target?.esm || !target.proxyPath) return false
  if (!matchesSource(resolvedPath, target.sourceHash)) {
    warnOnce(loaderContext, `changed:${resolvedPath}`, `Skipped changed dependency ${resolvedPath}`)
    return false
  }

  const replacement = relativeImport(path.dirname(resourcePath), target.proxyPath)
  for (const node of edge.nodes) setModuleSpecifier(node, replacement)
  return true
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
 * @param {object} [sourceMap]
 * @param {string} resourcePath
 * @param {PlanTarget} [match]
 * @param {boolean} esm
 * @param {(error?: Error, code?: string, sourceMap?: object) => void} callback
 */
function finishLoad (source, sourceMap, resourcePath, match, esm, callback) {
  if (!match) {
    callback(undefined, source, sourceMap)
    return
  }

  const rewritten = rewriteBundledWithSourceMap(
    source,
    resourcePath,
    esm ? 'module' : 'commonjs',
    undefined,
    sourceMap
  )
  const code = esm ? rewritten.code : appendCommonJsPublications(rewritten.code, resourcePath, match)
  callback(undefined, code, rewritten.map)
}

/**
 * @param {string} source
 * @param {string} resourcePath
 * @param {{ payloads: object[] }} match
 * @returns {string}
 */
function appendCommonJsPublications (source, resourcePath, match) {
  let publications = ''
  let publicationIndex = 0

  for (const payload of match.payloads) {
    const payloadName = `payload${publicationIndex++}`
    publications += `    const ${payloadName} = {
      instrumentationIndexes: ${JSON.stringify(payload.instrumentationIndexes)},
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
  /* eslint-disable @stylistic/quotes */
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  const nativeDc = require('node:diagnostics_channel')
  const dc = globalThis[Symbol.for(${JSON.stringify(BUNDLER_DC_GLOBAL)})] ?? nativeDc
  const channel = dc.channel('${CHANNEL}')
  if (channel.hasSubscribers) {
${publications}  }
}
`
}

/**
 * @param {string} file
 * @param {string} expectedHash
 * @returns {boolean}
 */
function matchesSource (file, expectedHash) {
  return getFileHash(file) === expectedHash
}

/**
 * @param {string} file
 * @returns {string}
 */
function getFileHash (file) {
  const { ctimeMs, mtimeMs, size } = fs.statSync(file)
  const cached = fileHashes.get(file)
  if (cached?.ctimeMs === ctimeMs && cached.mtimeMs === mtimeMs && cached.size === size) return cached.hash

  const value = hash(fs.readFileSync(file))
  if (fileHashes.size >= MAX_CACHED_FILES) fileHashes.delete(fileHashes.keys().next().value)
  fileHashes.set(file, { ctimeMs, hash: value, mtimeMs, size })
  return value
}

/**
 * @param {string|Buffer} value
 * @returns {string}
 */
function hash (value) {
  return createHash('sha256').update(value).digest('hex')
}

function relativeImport (from, to) {
  let value = path.relative(from, to).replaceAll('\\', '/')
  if (!value.startsWith('.')) value = `./${value}`
  return value
}

function normalizePath (value) {
  return fs.realpathSync(value).replaceAll('\\', '/')
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
  if (typeof loaderContext.emitWarning === 'function') loaderContext.emitWarning(warning)
  else process.emitWarning(warning)
}
