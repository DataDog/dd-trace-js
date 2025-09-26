'use strict'

// Inspired by import-in-the-middle

const { pathToFileURL, fileURLToPath } = require('url')
const { NODE_MAJOR, NODE_MINOR } = require('../../../version.js')
const fs = require('fs')

let getExports
const getExportsImporting = (url) => import(url).then(Object.keys)
if (NODE_MAJOR >= 20 || (NODE_MAJOR === 18 && NODE_MINOR >= 19)) {
  getExports = require('import-in-the-middle/lib/get-exports.js')
} else {
  getExports = getExportsImporting
}

/**
 * Determines if a specifier represents an export all ESM line.
 * Note that the expected `line` isn't 100% valid ESM. It is derived
 * from the `getExports` function wherein we have recognized the true
 * line and re-mapped it to one we expect.
 *
 * @param {string} line
 * @returns {boolean}
 */
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

  // eslint-disable-next-line no-prototype-builtins
  if (URL.hasOwnProperty('canParse')) {
    return !URL.canParse(specifier)
  }

  try {
    // eslint-disable-next-line no-new
    new URL(specifier)
    return false
  } catch (err) {
    return true
  }
}

async function processModule({ path, internal, context, parentGetSource, parentResolve, excludeDefault}) {
  let exportNames
  if (internal) {
    exportNames = await getExportsImporting(path)
  } else {
    const srcUrl = pathToFileURL(path)
    exportNames = await getExports(srcUrl, {}, async function parentLoad () {
      return {
        source: fs.readFileSync(path, 'utf8'),
        format: 'module',
        shortCircuit: true
      }
    })
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
      const [, modFile] = n.split('* from ')
  
      // Relative paths need to be resolved relative to the parent module
      const newSpecifier = isBareSpecifier(modFile) ? modFile : new URL(modFile, srcUrl).href
      // We need to call `parentResolve` to resolve bare specifiers to a full
      // URL. We also need to call `parentResolve` for all sub-modules to get
      // the `format`. We can't rely on the parents `format` to know if this
      // sub-module is ESM or CJS!
      const result = await parentResolve(newSpecifier, { parentURL: srcUrl })
  
      const subSetters = await processModule({
        srcUrl: result.url,
        context: { ...context, format: result.format },
        parentGetSource,
        parentResolve,
        excludeDefault: true
      })
  
      for (const [name, setter] of subSetters.entries()) {
        addSetter(name, setter, true)
      }
    } else {
      const variableName = `$${n.replace(/[^a-zA-Z0-9_$]/g, '_')}`
      const objectKey = JSON.stringify(n)
      const reExportedName = n === 'default' || NODE_MAJOR < 16 ? n : objectKey
  
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

module.exports = {
    processModule
}