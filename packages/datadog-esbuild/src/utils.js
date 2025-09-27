'use strict'

// Based in import-in-the-middle
const { pathToFileURL, fileURLToPath } = require('node:url')
const fs = require('node:fs')
const path = require('node:path')
const { NODE_MAJOR, NODE_MINOR } = require('../../../version.js')

const getExportsImporting = (url) => import(url).then(Object.keys)
const getExports = NODE_MAJOR >= 20 || (NODE_MAJOR === 18 && NODE_MINOR >= 19)
  ? require('import-in-the-middle/lib/get-exports.js')
  : getExportsImporting

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

function resolve (specifier, context) {
  // This comes from an import, that is why import makes preference
  const conditions = ['import']

  if (specifier.startsWith('file://')) {
    specifier = fileURLToPath(specifier)
  }

  const resolved = require.resolve(specifier, { conditions, paths: [fileURLToPath(context.parentURL)] })

  return {
    url: pathToFileURL(resolved),
    format: isESMFile(resolved) ? 'module' : 'commonjs'
  }
}

function getSource (url, { format }) {
  return {
    source: fs.readFileSync(fileURLToPath(url), 'utf8'),
    format
  }
}

/**
 * Generates the pieces of code for the proxy module before the path
 *
 * @param {Object} { path, internal, context, excludeDefault }
 * @returns {Map}
 */
async function processModule ({ path, internal, context, excludeDefault }) {
  let exportNames, srcUrl
  if (internal) {
    // we can not read and parse of internal modules
    exportNames = await getExportsImporting(path)
  } else {
    srcUrl = pathToFileURL(path)
    exportNames = await getExports(srcUrl, context, getSource)
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

  for (const n of exportNames) {
    if (n === 'default' && excludeDefault) continue

    if (isStarExportLine(n) === true) {
      // export * from 'wherever'
      const [, modFile] = n.split('* from ')

      // Relative paths need to be resolved relative to the parent module
      const newSpecifier = isBareSpecifier(modFile) ? modFile : new URL(modFile, srcUrl).href
      // We need to call `parentResolve` to resolve bare specifiers to a full
      // URL. We also need to call `parentResolve` for all sub-modules to get
      // the `format`. We can't rely on the parents `format` to know if this
      // sub-module is ESM or CJS!

      const result = resolve(newSpecifier, { parentURL: srcUrl })

      // eslint-disable-next-line no-await-in-loop
      const subSetters = await processModule({
        path: fileURLToPath(result.url),
        context: { ...context, format: result.format },
        excludeDefault: true
      })

      for (const [name, setter] of subSetters.entries()) {
        addSetter(name, setter, true)
      }
    } else {
      const variableName = `$${n.replaceAll(/[^a-zA-Z0-9_$]/g, '_')}`
      const objectKey = JSON.stringify(n)
      const reExportedName = n === 'default' ? n : objectKey

      addSetter(n, `
      let ${variableName}
      try {
        ${variableName} = _[${objectKey}] = namespace[${objectKey}]
      } catch (err) {
        if (!(err instanceof ReferenceError)) throw err
      }
      export { ${variableName} as ${reExportedName} }
      set[${objectKey}] = (v) => {
        ${variableName} = v
        return true
      }
      get[${objectKey}] = () => ${variableName}
      `)
    }
  }

  return setters
}

/**
 * Determines if a file is a ESM module or CommonJS
 *
 * @param {string} fullPathToModule File to analize
 * @param {string} modulePackageJsonPath Path of the package.json
 * @param {string} packageJson The content of the module package.json
 * @returns {boolean} 
 */
function isESMFile (fullPathToModule, modulePackageJsonPath, packageJson = {}) {
  if (fullPathToModule.endsWith('.mjs')) return true
  if (fullPathToModule.endsWith('.cjs')) return false

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
      if (packageJson?.type) { // TODO check if type is mandatory or defaulted to commonjs
        return packageJson.type === 'module'
      }
    } catch {
      // file does not exit, continue
    }
  } while (pathParts.length > 0)

  return packageJson.type === 'module'
}

module.exports = {
  processModule,
  isESMFile
}
