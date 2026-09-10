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
