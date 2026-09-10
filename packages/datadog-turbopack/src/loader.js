'use strict'

const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')

const extractPackageAndModulePath = require(
  '../../datadog-instrumentations/src/helpers/extract-package-and-module-path'
)
const hooks = require('../../datadog-instrumentations/src/helpers/hooks')
const instrumentations = require('../../datadog-instrumentations/src/helpers/instrumentations')
const { filename, matchesInstrumentation } = require('../../datadog-instrumentations/src/helpers/instrumentation-utils')
const { createBundlerRewriter } = require('../../datadog-instrumentations/src/helpers/rewriter')
const { getRewriteTarget } = require('../../datadog-instrumentations/src/helpers/rewriter/targets')
const rewriteTargets = require('../../datadog-instrumentations/src/helpers/rewriter/targets.json')
const { isESMFile } = require('../../datadog-esbuild/src/utils')
const { SYNTHETIC_EXTENSION } = require('./constants')

const CHANNEL = 'dd-trace:bundler:load'
const targetPackages = new Set([...Object.keys(hooks), ...Object.values(rewriteTargets)])
const entrypoints = new Map()
const loadedHooks = new Set()
const packageCache = new Map()
const rewriters = new Map()

/**
 * @typedef {object} LoaderContext
 * @property {(error: Error|undefined, code?: string, sourceMap?: string|object) => void} callback
 * @property {(warning: Error) => void} [emitWarning]
 * @property {string} resourcePath
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
 * Instruments a resolved foreign Node.js module.
 *
 * @this {LoaderContext}
 * @param {string} source
 * @param {string|object} [inputSourceMap]
 */
module.exports = function loader (source, inputSourceMap) {
  try {
    const nativeResourcePath = fs.realpathSync(getResourcePath(this))
    const resourcePath = nativeResourcePath.replaceAll('\\', '/')
    const extracted = extractPackageAndModulePath(resourcePath)
    const rewriteTarget = getRewriteTarget(resourcePath)
    if (!rewriteTarget && (!extracted.pkg || !targetPackages.has(extracted.pkg))) {
      this.callback(undefined, source, inputSourceMap)
      return
    }

    const packageInfo = extracted.pkg && extracted.pkgJson
      ? getPackageInfo(nativeResourcePath, extracted.pkg, extracted.path, path.normalize(extracted.pkgJson))
      : undefined
    if (rewriteTarget && !packageInfo) {
      throw new Error(`Could not derive package metadata for Turbopack rewrite target ${resourcePath}`)
    }
    const esm = packageInfo?.esm ?? isESMFile(nativeResourcePath)
    const publications = !esm && packageInfo ? getPublications(resourcePath, packageInfo) : []
    if (!rewriteTarget && publications.length === 0) {
      this.callback(undefined, source, inputSourceMap)
      return
    }
    if (publications.length > 0 && hasUnsafeCommonJsBindings(source)) {
      this.emitWarning?.(new Error(`Skipped CommonJS publication for unsafe wrapper bindings in ${resourcePath}`))
      this.callback(undefined, source, inputSourceMap)
      return
    }

    const dcModule = relativeImport(path.dirname(nativeResourcePath), require.resolve('dc-polyfill'))
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
    if (rewritten && publications.length === 0) {
      if (!esm && hasUnsafeCommonJsBindings(code)) {
        this.emitWarning?.(new Error(`Skipped CommonJS activation for unsafe wrapper bindings in ${resourcePath}`))
        this.callback(undefined, source, inputSourceMap)
        return
      }
      code = appendActivation(code, {
        package: rewriteTarget.moduleName,
        path: filename(rewriteTarget.moduleName, rewriteTarget.filePath),
        version: packageInfo.version,
      }, dcModule, esm)
    }
    this.callback(undefined, code, sourceMap)
  } catch (error) {
    this.callback(error instanceof Error ? error : new Error(String(error)))
  }
}

/**
 * @param {LoaderContext} context
 * @returns {string}
 */
function getResourcePath (context) {
  const { resourcePath } = context
  if (!resourcePath.endsWith(SYNTHETIC_EXTENSION) || fs.existsSync(resourcePath)) return resourcePath

  const extensionlessPath = resourcePath.slice(0, -SYNTHETIC_EXTENSION.length)
  return fs.existsSync(extensionlessPath) ? extensionlessPath : resourcePath
}

/**
 * @param {string} nativeResourcePath
 * @param {string} name
 * @param {string|null} modulePath
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
    moduleName: filename(name, modulePath || undefined),
    name,
    packageJsonPath,
    version: cached.version,
  }
}

/**
 * @param {string} resourcePath
 * @param {PackageInfo} packageInfo
 * @returns {Array<{ package: string, path: string, version: string }>}
 */
function getPublications (resourcePath, packageInfo) {
  loadPackageHook(packageInfo.name)
  const entries = instrumentations[packageInfo.name]
  if (!entries) return []

  const publications = []
  const paths = new Set()
  for (const entry of entries) {
    if (!entry.file && !entry.filePattern) {
      packageInfo.entrypoint ??= getCommonJsEntrypoint(packageInfo.name, packageInfo.packageJsonPath)
    }
    const moduleName = entry.file || entry.filePattern
      ? packageInfo.moduleName
      : resourcePath === packageInfo.entrypoint ? packageInfo.name : undefined
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
 * @returns {string}
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
  loadedHooks.add(name)
  const hook = hooks[name]
  const load = hook?.fn ?? hook
  if (typeof load === 'function') load()
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
 * @returns {boolean}
 */
function hasUnsafeCommonJsBindings (source) {
  try {
    const { parse } = require('../../datadog-instrumentations/src/helpers/rewriter/compiler')
    if (source.startsWith('#!')) source = `//${source.slice(2)}`
    const program = parse(Module.wrap(source))
    const wrapper = program.body[0]?.expression
    return wrapper?.type !== 'FunctionExpression' || hasUnsafeNode(wrapper.body, 0, true)
  } catch {
    return true
  }
}

/**
 * @param {object} node
 * @param {number} functionDepth
 * @param {boolean} commonJsArguments
 * @param {object} [parent]
 * @param {string} [parentKey]
 * @returns {boolean}
 */
function hasUnsafeNode (node, functionDepth, commonJsArguments, parent, parentKey) {
  if (functionDepth === 0 && hasCommonJsDeclaration(node)) return true
  if (node.type === 'AssignmentExpression' && mutatesCommonJsBinding(node.left)) return true
  if (node.type === 'UpdateExpression' && mutatesCommonJsBinding(node.argument)) return true
  if ((node.type === 'ForInStatement' || node.type === 'ForOfStatement') &&
    mutatesCommonJsBinding(node.left)) return true
  if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'eval') return true
  if (commonJsArguments && node.type === 'Identifier' && node.name === 'arguments' &&
    isReferencedIdentifier(parent, parentKey)) return true

  const nestedFunction = node.type === 'ArrowFunctionExpression' || node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression'
  if (nestedFunction) {
    functionDepth++
    commonJsArguments = node.type === 'ArrowFunctionExpression' &&
      !node.params.some(param => bindsName(param, 'arguments')) && commonJsArguments
  }

  for (const key of Object.keys(node)) {
    if ((node.type === 'VariableDeclarator' && key === 'id') ||
      (node.type === 'CatchClause' && key === 'param')) continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child?.type && hasUnsafeNode(child, functionDepth, commonJsArguments, node, key)) return true
      }
    } else if (value?.type && hasUnsafeNode(value, functionDepth, commonJsArguments, node, key)) {
      return true
    }
  }
  return false
}

/**
 * @param {object} node
 * @returns {boolean}
 */
function hasCommonJsDeclaration (node) {
  if (node.type === 'VariableDeclarator') {
    return bindsName(node.id, 'module') || bindsName(node.id, 'require')
  }
  if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
    return node.id?.name === 'module' || node.id?.name === 'require'
  }
  return false
}

/**
 * @param {object} node
 * @returns {boolean}
 */
function mutatesCommonJsBinding (node) {
  return bindsName(node, 'module') || bindsName(node, 'require')
}

/**
 * @param {object} node
 * @param {string} name
 * @returns {boolean}
 */
function bindsName (node, name) {
  if (node.type === 'Identifier') return node.name === name
  if (node.type === 'AssignmentPattern') return bindsName(node.left, name)
  if (node.type === 'RestElement') return bindsName(node.argument, name)
  if (node.type === 'ArrayPattern') return node.elements.some(element => element && bindsName(element, name))
  if (node.type === 'ObjectPattern') {
    return node.properties.some(property => {
      return bindsName(property.type === 'RestElement' ? property.argument : property.value, name)
    })
  }
  return false
}

/**
 * @param {object} parent
 * @param {string} parentKey
 * @returns {boolean}
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
 * @returns {string}
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
 * @returns {string}
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
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
function relativeImport (from, to) {
  let value = path.relative(from, to).replaceAll('\\', '/')
  if (!value.startsWith('.')) value = `./${value}`
  return value
}
