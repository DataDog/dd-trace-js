'use strict'

const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')

const { isESMFile } = require('./bundler-utils')
const extractPackageAndModulePath = require('./extract-package-and-module-path')
const hooks = require('./hooks')
const instrumentations = require('./instrumentations')
const { filename, matchesInstrumentation } = require('./instrumentation-utils')
const { createBundlerRewriter } = require('./rewriter')
const {
  getRewriteTarget,
  getRewriteTargetNames,
} = require('./rewriter/targets')

const CHANNEL = 'dd-trace:bundler:load'
const ARGUMENTS_BINDING = 1
const MODULE_BINDING = 2
const REQUIRE_BINDING = 4
const COMMONJS_BINDINGS = MODULE_BINDING | REQUIRE_BINDING
const targetPackages = new Set(Object.keys(hooks))
for (const name of getRewriteTargetNames()) targetPackages.add(name)
const packagePathPattern = createPackagePathPattern()
const entrypoints = new Map()
const loadedHooks = new Set()
const packageCache = new Map()
const rewriters = new Map()

/**
 * @typedef {'orchestrion-rewrite'|'cjs-publication'|'esm-intercept'|'none'} Classification
 */

/**
 * @typedef {object} PackageInfo
 * @property {string} [entrypoint]
 * @property {boolean} esm
 * @property {string} moduleName
 * @property {string} name
 * @property {string} packageJsonPath
 * @property {string} version
 */

/**
 * @typedef {object} Target
 * @property {Classification} kind
 * @property {string} nativeResourcePath
 * @property {string} resourcePath
 * @property {PackageInfo} packageInfo
 * @property {Array<{ package: string, path: string, version: string }>} publications
 * @property {import('./rewriter/targets').RewriteTarget} [rewriteTarget]
 */

/**
 * Classifies a resolved package file. For ESM package-root hooks, request is the original
 * package specifier: resolving a dual package with require conditions can select a different file.
 * A rewrite classification may still append matching CommonJS publications.
 *
 * @param {{ resourcePath: string, request?: string, warn?: (warning: Error) => void }} options
 * @returns {Classification}
 */
function classify ({ resourcePath, request, warn }) {
  try {
    return getTarget(resourcePath, true, request)?.kind ?? 'none'
  } catch (error) {
    reportWarning(warn, error)
    return 'none'
  }
}

/**
 * Instruments a resolved foreign Node.js module, or leaves it untouched on error.
 *
 * @param {{ source: string, resourcePath: string, inputSourceMap?: string|object,
 *   warn?: (warning: Error) => void }} options
 * @returns {{ code: string, map?: string|object }|undefined}
 */
/* eslint-disable unicorn/no-useless-undefined -- Explicit optional returns satisfy noImplicitReturns. */
function instrument ({ source, resourcePath, inputSourceMap, warn }) {
  try {
    const target = getTarget(resourcePath, false)
    if (!target || target.kind === 'none') return undefined

    const { nativeResourcePath, packageInfo, publications, rewriteTarget } = target
    resourcePath = target.resourcePath
    const esm = packageInfo.esm
    if (publications.length > 0 && hasUnsafeCommonJsBindings(source)) {
      reportWarning(warn, new Error(`Skipped CommonJS publication for unsafe wrapper bindings in ${resourcePath}`))
      return undefined
    }

    const dcModule = getDcModule(nativeResourcePath)
    let code = source
    let sourceMap = inputSourceMap
    let rewritten = false
    if (rewriteTarget) {
      const rewrite = getRewriter(dcModule)
      const result = rewrite(
        source,
        resourcePath,
        esm ? 'module' : 'commonjs',
        rewriteTarget,
        inputSourceMap
      )
      code = /** @type {string} */ (result.code)
      sourceMap = result.map
      rewritten = code !== source
    }

    if (publications.length > 0) code = appendCommonJsPublications(code, publications, dcModule)
    if (rewritten && rewriteTarget && publications.length === 0 &&
      (rewriteTarget.activate || hooks[rewriteTarget.moduleName])) {
      if (!esm && hasUnsafeCommonJsBindings(code)) {
        reportWarning(warn, new Error(`Skipped CommonJS activation for unsafe wrapper bindings in ${resourcePath}`))
        return undefined
      }
      code = appendActivation(code, {
        package: rewriteTarget.moduleName,
        path: filename(rewriteTarget.moduleName, rewriteTarget.filePath),
        version: packageInfo.version,
      }, dcModule, esm)
    }
    return { code, map: sourceMap }
  } catch (error) {
    reportWarning(warn, error)
    return undefined
  }
}
/* eslint-enable unicorn/no-useless-undefined */

/**
 * @param {string} inputPath
 * @param {boolean} includeEsmHooks
 * @param {string} [request]
 * @returns {Target|undefined}
 */
function getTarget (inputPath, includeEsmHooks, request) {
  const nativeResourcePath = fs.realpathSync(inputPath)
  const resourcePath = nativeResourcePath.replaceAll('\\', '/')
  const extracted = extractPackageAndModulePath(resourcePath)
  if (!extracted.pkg || !targetPackages.has(extracted.pkg)) return

  const rewriteTarget = getRewriteTarget(resourcePath)
  const packageInfo = getPackageInfo(
    nativeResourcePath,
    extracted.pkg,
    /** @type {string} */ (extracted.path),
    path.normalize(/** @type {string} */ (extracted.pkgJson))
  )
  // Turbopack does not intercept ESM exports, so do not load ESM hooks for its transforms.
  const publications = packageInfo.esm
    ? includeEsmHooks && !rewriteTarget ? getPublications(resourcePath, packageInfo, request) : []
    : getPublications(resourcePath, packageInfo)
  /** @type {Classification} */
  const kind = rewriteTarget
    ? 'orchestrion-rewrite'
    : publications.length === 0
      ? 'none'
      : packageInfo.esm ? 'esm-intercept' : 'cjs-publication'
  return { kind, nativeResourcePath, resourcePath, packageInfo, publications, rewriteTarget }
}

/**
 * @param {((warning: Error) => void)|undefined} warn
 * @param {unknown} error
 */
function reportWarning (warn, error) {
  try {
    warn?.(error instanceof Error ? error : new Error(String(error)))
  } catch {
    // A bundler's warning callback must not turn a failed transform into a build failure.
  }
}

/**
 * @param {string} nativeResourcePath
 * @param {string} name
 * @param {string} modulePath
 * @param {string} packageJsonPath
 * @returns {PackageInfo}
 */
function getPackageInfo (nativeResourcePath, name, modulePath, packageJsonPath) {
  let cached = packageCache.get(packageJsonPath)
  if (!cached) {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
    cached = { packageJson, version: packageJson.version }
    packageCache.set(packageJsonPath, cached)
  }

  return {
    esm: isESMFile(nativeResourcePath, packageJsonPath, cached.packageJson),
    moduleName: filename(name, modulePath),
    name,
    packageJsonPath,
    version: cached.version,
  }
}

/**
 * @param {string} resourcePath
 * @param {PackageInfo} packageInfo
 * @param {string} [request]
 * @returns {Array<{ package: string, path: string, version: string }>}
 */
function getPublications (resourcePath, packageInfo, request) {
  loadPackageHook(packageInfo.name)
  const entries = instrumentations[packageInfo.name]
  if (!entries) return []

  const publications = []
  const paths = new Set()
  for (const entry of entries) {
    if (!packageInfo.esm && !entry.file && !entry.filePattern) {
      packageInfo.entrypoint ??= getCommonJsEntrypoint(packageInfo.name, packageInfo.packageJsonPath)
    }
    const isEntrypoint = packageInfo.esm ? request === packageInfo.name : resourcePath === packageInfo.entrypoint
    let moduleName
    if (entry.file || entry.filePattern) {
      moduleName = packageInfo.moduleName
    } else if (isEntrypoint) {
      moduleName = packageInfo.name
    }
    if (!moduleName || paths.has(moduleName) ||
      !matchesInstrumentation(packageInfo.name, packageInfo.version, moduleName, entry)) continue

    paths.add(moduleName)
    publications.push({ package: packageInfo.name, path: moduleName, version: packageInfo.version })
  }
  return publications
}

/**
 * @param {string} name
 * @param {string} packageJsonPath
 */
function getCommonJsEntrypoint (name, packageJsonPath) {
  const cached = entrypoints.get(packageJsonPath)
  if (cached) return cached

  const packageRequire = Module.createRequire(packageJsonPath)
  let entrypoint
  try {
    entrypoint = packageRequire.resolve(name)
  } catch {
    entrypoint = packageRequire.resolve(path.dirname(packageJsonPath))
  }
  const resolved = fs.realpathSync(entrypoint).replaceAll('\\', '/')
  entrypoints.set(packageJsonPath, resolved)
  return resolved
}

/**
 * @param {string} name
 */
function loadPackageHook (name) {
  if (loadedHooks.has(name)) return
  const hook = hooks[name]
  const load = hook?.fn ?? hook
  if (typeof load === 'function') load()
  loadedHooks.add(name)
}

/**
 * @param {string} dcModule
 * @returns {ReturnType<typeof createBundlerRewriter>}
 */
function getRewriter (dcModule) {
  const cached = rewriters.get(dcModule)
  if (cached) return cached
  const rewrite = createBundlerRewriter(dcModule)
  rewriters.set(dcModule, rewrite)
  return rewrite
}

/**
 * @param {string} source
 */
function hasUnsafeCommonJsBindings (source) {
  try {
    const { parse } = require('./rewriter/compiler')
    if (source.startsWith('#!')) source = `//${source.slice(2)}`
    const program = parse(Module.wrap(source))
    const wrapper = program.body[0]?.expression
    return wrapper?.type !== 'FunctionExpression' || hasUnsafeNode(wrapper.body, 0, 0)
  } catch {
    return true
  }
}

/**
 * @param {object} node
 * @param {number} functionDepth
 * @param {number} shadowedBindings
 * @param {object} [parent]
 * @param {string} [parentKey]
 */
function hasUnsafeNode (node, functionDepth, shadowedBindings, parent, parentKey) {
  if (functionDepth === 0 && hasCommonJsDeclaration(node, parent)) return true
  if (node.type === 'AssignmentExpression' && mutatesCommonJsBinding(node.left, shadowedBindings)) return true
  if (node.type === 'UpdateExpression' && mutatesCommonJsBinding(node.argument, shadowedBindings)) return true
  if ((node.type === 'ForInStatement' || node.type === 'ForOfStatement') &&
    mutatesCommonJsBinding(node.left, shadowedBindings)) return true
  if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'eval') return true
  if (!(shadowedBindings & ARGUMENTS_BINDING) && node.type === 'Identifier' && node.name === 'arguments' &&
    isReferencedIdentifier(parent, /** @type {string} */ (parentKey))) return true

  const nestedFunction = node.type === 'ArrowFunctionExpression' || node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression'
  if (nestedFunction) {
    functionDepth++
    shadowedBindings |= getFunctionBindings(node)
  }
  shadowedBindings |= getLexicalBindings(node)

  for (const key of Object.keys(node)) {
    if ((node.type === 'VariableDeclarator' && key === 'id') ||
      (node.type === 'CatchClause' && key === 'param')) continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child?.type && hasUnsafeNode(child, functionDepth, shadowedBindings, node, key)) return true
      }
    } else if (value?.type && hasUnsafeNode(value, functionDepth, shadowedBindings, node, key)) {
      return true
    }
  }
  return false
}

/**
 * @param {object} node
 * @param {object} [parent]
 */
function hasCommonJsDeclaration (node, parent) {
  if (node.type === 'VariableDeclarator') {
    return parent?.kind === 'var' && Boolean(getBindingMask(node.id) & COMMONJS_BINDINGS)
  }
  if (node.type === 'FunctionDeclaration') {
    return Boolean(getBindingMask(node.id) & COMMONJS_BINDINGS)
  }
  return false
}

/**
 * @param {object} node
 * @param {number} shadowedBindings
 */
function mutatesCommonJsBinding (node, shadowedBindings) {
  return Boolean(getBindingMask(node) & COMMONJS_BINDINGS & ~shadowedBindings)
}

/**
 * @param {object} node
 */
function getBindingMask (node) {
  if (!node) return 0
  if (node.type === 'Identifier') {
    if (node.name === 'arguments') return ARGUMENTS_BINDING
    if (node.name === 'module') return MODULE_BINDING
    return node.name === 'require' ? REQUIRE_BINDING : 0
  }
  if (node.type === 'AssignmentPattern') return getBindingMask(node.left)
  if (node.type === 'RestElement') return getBindingMask(node.argument)
  if (node.type === 'ArrayPattern') {
    let bindings = 0
    for (const element of node.elements) bindings |= getBindingMask(element)
    return bindings
  }
  if (node.type === 'ObjectPattern') {
    let bindings = 0
    for (const property of node.properties) {
      bindings |= getBindingMask(property.type === 'RestElement' ? property.argument : property.value)
    }
    return bindings
  }
  return 0
}

/**
 * @param {object} node
 */
function getFunctionBindings (node) {
  let bindings = node.type === 'ArrowFunctionExpression' ? 0 : ARGUMENTS_BINDING
  bindings |= getBindingMask(node.id)
  for (const param of node.params) bindings |= getBindingMask(param)
  return bindings | getVarBindings(node.body)
}

/**
 * @param {object} node
 */
function getVarBindings (node) {
  if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' || node.type === 'ClassDeclaration' || node.type === 'ClassExpression') return 0

  let bindings = 0
  if (node.type === 'VariableDeclaration' && node.kind === 'var') {
    for (const declaration of node.declarations) bindings |= getBindingMask(declaration.id)
  }
  for (const key of Object.keys(node)) {
    const value = node[key]
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child?.type) bindings |= getVarBindings(child)
      }
    } else if (value?.type) {
      bindings |= getVarBindings(value)
    }
  }
  return bindings
}

/**
 * @param {object} node
 */
function getLexicalBindings (node) {
  let bindings = 0
  if (node.type === 'BlockStatement') {
    for (const statement of node.body) bindings |= getStatementBindings(statement)
  } else if (node.type === 'SwitchStatement') {
    for (const switchCase of node.cases) {
      for (const statement of switchCase.consequent) bindings |= getStatementBindings(statement)
    }
  } else if (node.type === 'CatchClause') {
    bindings = getBindingMask(node.param)
  } else if (node.type === 'ForStatement') {
    bindings = getLexicalDeclarationBindings(node.init)
  } else if (node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
    bindings = getLexicalDeclarationBindings(node.left)
  } else if (node.type === 'ClassExpression') {
    bindings = getBindingMask(node.id)
  }
  return bindings
}

/**
 * @param {object} node
 */
function getStatementBindings (node) {
  if (node.type === 'VariableDeclaration') return getLexicalDeclarationBindings(node)
  if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') return getBindingMask(node.id)
  return 0
}

/**
 * @param {object} [node]
 */
function getLexicalDeclarationBindings (node) {
  if (node?.type !== 'VariableDeclaration' || node.kind === 'var') return 0
  let bindings = 0
  for (const declaration of node.declarations) bindings |= getBindingMask(declaration.id)
  return bindings
}

/**
 * @param {object} parent
 * @param {string} parentKey
 */
function isReferencedIdentifier (parent, parentKey) {
  if (parent.type === 'MemberExpression' && parentKey === 'property' && !parent.computed) return false
  if ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') &&
    parentKey === 'key' && !parent.computed) {
    return parent.type === 'Property' && parent.shorthand
  }
  return parentKey !== 'label'
}

/**
 * @param {string} source
 * @param {Array<{ package: string, path: string, version: string }>} payloads
 * @param {string} dcModule
 */
function appendCommonJsPublications (source, payloads, dcModule) {
  let publications = ''
  let index = 0
  for (const payload of payloads) {
    publications += `    const payload${index} = {
      module: module.exports,
      package: ${JSON.stringify(payload.package)},
      path: ${JSON.stringify(payload.path)},
      version: ${JSON.stringify(payload.version)},
    }
    channel.publish(payload${index})
    module.exports = payload${index++}.module
`
  }

  return `${source}
{
  const dc = require(${JSON.stringify(dcModule)})
  const channel = dc.channel('${CHANNEL}')
  if (channel.hasSubscribers) {
${publications}  }
}
`
}

/**
 * @param {string} source
 * @param {{ package: string, path: string, version: string }} payload
 * @param {string} dcModule
 * @param {boolean} esm
 */
function appendActivation (source, payload, dcModule, esm) {
  if (esm) {
    return `${source}
import ddTraceTurbopackDc from ${JSON.stringify(dcModule)}
{
  const channel = ddTraceTurbopackDc.channel('${CHANNEL}')
  if (channel.hasSubscribers) channel.publish(${JSON.stringify({ activate: true, ...payload })})
}
`
  }

  return `${source}
{
  const dc = require(${JSON.stringify(dcModule)})
  const channel = dc.channel('${CHANNEL}')
  if (channel.hasSubscribers) channel.publish(${JSON.stringify({ activate: true, ...payload })})
}
`
}

/**
 * Matches paths containing a directory named after a target package. Bundlers use it as a cheap
 * prefilter; the instrumentation still resolves the real package before changing a file.
 *
 * @returns {RegExp}
 */
function createPackagePathPattern () {
  const builtins = new Set(Module.builtinModules)
  const names = []
  for (const name of targetPackages) {
    if (!name.startsWith('.') && !builtins.has(name)) names.push(escapeRegExp(name))
  }
  names.sort()
  return new RegExp(`(?:^|/)(?:${names.join('|')})(?:/|$)`)
}

/**
 * @param {string} value
 */
function escapeRegExp (value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

/**
 * @param {string} nativeResourcePath
 */
function getDcModule (nativeResourcePath) {
  let value = path.relative(path.dirname(nativeResourcePath), require.resolve('dc-polyfill')).replaceAll('\\', '/')
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error(`Cannot create a relative diagnostic-channel import from ${nativeResourcePath}`)
  }
  if (!value.startsWith('./') && !value.startsWith('../')) value = `./${value}`
  return value
}

module.exports = { classify, instrument, packagePathPattern }
