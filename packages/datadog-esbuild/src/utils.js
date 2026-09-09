'use strict'

// The content of this file is copied from the `import-in-the-middle` package with minor modifications (https://www.npmjs.com/package/import-in-the-middle)
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath, pathToFileURL } = require('node:url')

const { createEsmResolver, driveGetExportsGenerator } = require('./resolver')

/** @typedef {ReturnType<typeof createEsmResolver>} EsmResolver */

const getExportsImporting = (url) => import(url).then(Object.keys)
let getExportsModulePromise

const loadGetExportsModule = () => {
  if (!getExportsModulePromise) {
    getExportsModulePromise = import('import-in-the-middle/lib/get-exports.mjs')
  }
  return getExportsModulePromise
}

/**
 * @param {URL} srcUrl
 * @param {object} context
 * @param {(url: URL, context: object) => { source: string, format: string }} getSource
 * @param {EsmResolver} resolver
 * @returns {Promise<{
 *   exportNames: Iterable<string>,
 *   starReexports?: Array<{ specifier: string, parentURL: string }>
 * }>}
 */
const getExports = async (srcUrl, context, getSource, resolver) => {
  const mod = await loadGetExportsModule()
  const exportsGenerator = mod.getExports(srcUrl, context, getSource)
  /**
   * @param {string} specifier
   * @param {{ parentURL: URL }} operationContext
   * @returns {Promise<{ format: string, url: URL }>}
   */
  const resolve = (specifier, operationContext) => resolveModule(specifier, operationContext, resolver)
  return driveGetExportsGenerator(exportsGenerator, getSource, resolve)
}

function isStarExportLine (line) {
  return /^\* from /.test(line)
}

function isBareSpecifier (specifier) {
  // Relative and absolute paths are not bare specifiers.
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/')) {
    return false
  }

  // Valid URLs are not bare specifiers. (file:, http:, node:, etc.)

  if (URL.hasOwnProperty('canParse')) {
    // eslint-disable-next-line n/no-unsupported-features/node-builtins
    return !URL.canParse(specifier)
  }

  try {
    // eslint-disable-next-line no-new
    new URL(specifier)
    return false
  } catch {
    return true
  }
}

/**
 * Resolves a module with the import conditions used by ESM instrumentation.
 *
 * @param {string} specifier
 * @param {{ parentURL: URL }} context
 * @param {EsmResolver} resolver
 * @returns {Promise<{ format: string, url: URL }>}
 */
async function resolveModule (specifier, context, resolver) {
  const url = new URL(await resolver.resolve(specifier, context.parentURL))
  if (url.protocol === 'node:') return { format: 'builtin', url }
  if (url.protocol !== 'file:') throw new Error(`Unsupported ESM resolution URL: ${url.href}`)

  const resolved = fileURLToPath(url)
  if (resolved.endsWith('.json') || resolved.endsWith('.node')) {
    throw new Error(`Unsupported ESM analysis target: ${resolved}`)
  }
  return {
    format: isESMFile(resolved) ? 'module' : 'commonjs',
    url,
  }
}

/**
 * Generates the pieces of code for the proxy module before the path
 *
 * @param {object} moduleData
 * @param {string} moduleData.path
 * @param {boolean} [moduleData.internal]
 * @param {object} moduleData.context
 * @param {boolean} [moduleData.excludeDefault]
 * @param {Map<string, string>} [moduleData.moduleSources]
 * @param {EsmResolver} [moduleData.resolver]
 * @param {Set<string>} [activeModules]
 * @returns {Promise<Map>}
 */
async function processModule (
  { path, internal = false, context, excludeDefault = false, moduleSources = new Map(), resolver },
  activeModules
) {
  const ownsResolver = resolver === undefined
  resolver ??= createEsmResolver()
  try {
    return await processModuleWithResolver(
      { path, internal, context, excludeDefault, moduleSources },
      activeModules,
      resolver
    )
  } finally {
    if (ownsResolver) await resolver.close()
  }
}

/**
 * @param {object} moduleData
 * @param {string} moduleData.path
 * @param {boolean} moduleData.internal
 * @param {object} moduleData.context
 * @param {boolean} moduleData.excludeDefault
 * @param {Map<string, string>} moduleData.moduleSources
 * @param {Set<string>} [activeModules]
 * @param {EsmResolver} resolver
 * @returns {Promise<Map>}
 */
async function processModuleWithResolver (
  { path, internal, context, excludeDefault, moduleSources },
  activeModules,
  resolver
) {
  let moduleExports, srcUrl
  if (internal) {
    // we can not read and parse of internal modules
    moduleExports = { exportNames: await getExportsImporting(path) }
  } else {
    srcUrl = pathToFileURL(path)
    const loadSource = (url, { format }) => {
      const modulePath = fileURLToPath(url)
      let source = moduleSources.get(modulePath)
      if (source === undefined) {
        source = fs.readFileSync(modulePath, 'utf8')
        moduleSources.set(modulePath, source)
      }
      return { source, format }
    }
    loadSource(srcUrl, context)
    moduleExports = await getExports(srcUrl, context, loadSource, resolver)
  }

  const starExports = new Set()
  const setters = new Map()

  const addSetter = (name, setter, isStarExport = false) => {
    if (setters.has(name)) {
      if (isStarExport) {
        // If there's already a matching star export, delete it
        if (starExports.has(name)) {
          setters.delete(name)
        }
        // and return so this is excluded
        return
      }

      // if we already have this export but it is from a * export, overwrite it
      if (starExports.has(name)) {
        starExports.delete(name)
        setters.set(name, setter)
      }
    } else {
      // Store export * exports so we know they can be overridden by explicit
      // named exports
      if (isStarExport) {
        starExports.add(name)
      }

      setters.set(name, setter)
    }
  }

  let starReexports = moduleExports.starReexports
  for (const n of moduleExports.exportNames) {
    if (n === 'default' && excludeDefault) continue

    if (isStarExportLine(n)) {
      starReexports ??= []
      starReexports.push({ parentURL: srcUrl.href, specifier: n.slice('* from '.length) })
      continue
    }

    const variableName = `$dd${Buffer.from(n).toString('hex')}`
    const objectKey = JSON.stringify(n)
    const reExportedName = n === 'default' ? n : objectKey

    addSetter(n, `
      let ${variableName}
      try {
        ${variableName} = _[${objectKey}] = namespace[${objectKey}]
      } catch (error) {
        if (!(error instanceof ReferenceError)) throw error
      }
      export { ${variableName} as ${reExportedName} }
      set[${objectKey}] = (v) => {
        ${variableName} = v
        return true
      }
      get[${objectKey}] = () => ${variableName}
      `)
  }

  if (starReexports) {
    for (const { parentURL, specifier } of starReexports) {
      const baseUrl = new URL(parentURL)
      const resolvedSpecifier = isBareSpecifier(specifier) ? specifier : new URL(specifier, baseUrl).href
      // The runtime's import conditions and the declaring module's URL own star-export resolution.
      // eslint-disable-next-line no-await-in-loop
      const result = await resolveModule(resolvedSpecifier, { parentURL: baseUrl }, resolver)

      activeModules ??= new Set([srcUrl.href])
      if (activeModules.has(result.url.href)) continue
      activeModules.add(result.url.href)

      // eslint-disable-next-line no-await-in-loop
      const subSetters = await processModuleWithResolver({
        path: result.format === 'builtin' ? result.url.href : fileURLToPath(result.url),
        internal: result.format === 'builtin',
        context: { ...context, format: result.format },
        excludeDefault: true,
        moduleSources,
      }, activeModules, resolver)
      activeModules.delete(result.url.href)

      for (const [name, setter] of subSetters.entries()) {
        addSetter(name, setter, true)
      }
    }
  }

  return setters
}

/**
 * Determines if a file is a ESM module or CommonJS
 *
 * @param {string} fullPathToModule File to analize
 * @param {string} [modulePackageJsonPath] Path of the package.json
 * @param {object} [packageJson] The content of the module package.json
 * @returns {boolean}
 */
function isESMFile (fullPathToModule, modulePackageJsonPath, packageJson = {}) {
  if (fullPathToModule.endsWith('.mjs') || fullPathToModule.endsWith('.mts')) return true
  if (fullPathToModule.endsWith('.cjs') || fullPathToModule.endsWith('.cts')) return false

  const pathParts = fullPathToModule.split(path.sep)
  do {
    pathParts.pop()

    const packageJsonPath = [...pathParts, 'package.json'].join(path.sep)
    if (packageJsonPath === modulePackageJsonPath) {
      return packageJson.type === 'module'
    }

    try {
      const packageJsonContent = fs.readFileSync(packageJsonPath).toString()
      const packageJson = JSON.parse(packageJsonContent)
      return packageJson.type === 'module'
    } catch {
      // file does not exit, continue
    }
  } while (pathParts.length > 0)

  return packageJson.type === 'module'
}

module.exports = {
  isESMFile,
  processModule,
}
