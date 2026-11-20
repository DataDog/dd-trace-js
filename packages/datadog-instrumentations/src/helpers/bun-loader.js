'use strict'

const { readFileSync } = require('node:fs')
const Module = require('node:module')
const { builtinModules } = Module
const path = require('node:path')
const { fileURLToPath, pathToFileURL } = require('node:url')

const dc = require('dc-polyfill')

const moduleDetailsFromPath = require('../../../../vendor/dist/module-details-from-path')
const regexpEscape = require('../../../../vendor/dist/escape-string-regexp').default
const log = require('../../../dd-trace/src/log')
const hooks = require('./hooks')
const { getRewriteTargetNames } = require('./rewriter/targets')
const { isRelativeRequire } = require('./shared-utils')

// Bun keeps a query on an absolute path import as a separate module record, which lets the
// import-in-the-middle wrapper import the original module under the same file path.
const ORIGINAL_QUERY = '?dd-trace=original'
const EXPORTS_KEY = Symbol.for('dd-trace.bun.commonjs-exports')
const PARENT_URL = pathToFileURL(__filename).href

const packageTypes = new Map()
const packageSpecifiers = new Map()
let isRegistered = false
let iitmHook
let rewriterLoader

/**
 * Registers a Bun runtime plugin that applies import-in-the-middle wrapping and Orchestrion
 * rewriting to instrumented packages, as Bun does not run Node.js module loader hooks.
 */
function register () {
  if (isRegistered || !process.versions.bun) return
  isRegistered = true

  const { createHook } = require('import-in-the-middle/create-hook.mjs')
  const { prepareImportInTheMiddleOptions } = require('../../../../loader-hook.mjs')

  iitmHook = createHook({ url: pathToFileURL(require.resolve('import-in-the-middle/hook.mjs')).href })
  iitmHook.applyOptions(prepareImportInTheMiddleOptions())
  rewriterLoader = require('./rewriter/loader.mjs')

  globalThis[EXPORTS_KEY] = new Map()

  // A file first loaded by `require()` is reused by later imports without another plugin call, so
  // its facade must pick up the exports as replaced by the require hooks.
  dc.channel('dd-trace:moduleHooked').subscribe(({ filename, exports }) => {
    const state = globalThis[EXPORTS_KEY].get(filename)
    if (state) {
      state.exports = exports
      state.update?.(exports)
    }
  })

  globalThis.Bun.plugin({
    name: 'dd-trace',
    setup (build) {
      build.onLoad({ filter: getFilter() }, load)
    },
  })
}

function getFilter () {
  const names = new Set(getRewriteTargetNames())
  for (const name of Object.keys(hooks)) {
    if (!isRelativeRequire(name) && !builtinModules.includes(name)) names.add(name)
  }

  let alternation = ''
  for (const name of names) {
    if (alternation !== '') alternation += '|'
    alternation += regexpEscape(name).replaceAll('/', String.raw`[\\/]`)
  }

  const query = regexpEscape(ORIGINAL_QUERY)
  const file = String.raw`(?:(?!node_modules[\\/]).)*\.[cm]?js(?:${query})?$`

  return new RegExp(String.raw`[\\/]node_modules[\\/](?:${alternation})[\\/]` + file)
}

/**
 * @param {{ path: string }} args
 */
function load ({ path: requestPath }) {
  const isOriginal = requestPath.endsWith(ORIGINAL_QUERY)
  const filename = isOriginal ? requestPath.slice(0, -ORIGINAL_QUERY.length) : requestPath

  if (getFormat(filename) === 'commonjs') return loadCommonJs(filename)

  try {
    if (!isOriginal) {
      const wrapper = wrap(filename)
      if (wrapper) return { loader: 'js', contents: wrapper }
    }

    return { loader: 'js', contents: rewrite(filename) }
  } catch (error) {
    log.error('Unable to instrument ES module %s on Bun', filename, error)
    return { loader: 'js', contents: readFileSync(filename, 'utf8') }
  }
}

/**
 * Bun calls plugins for `require()` too, and requires an object for every matched file. The
 * module is compiled through `Module.prototype._compile` (so the Orchestrion CommonJS rewriter
 * and require hooks apply) and exposed through Bun's `module.exports` interop export.
 *
 * @param {string} filename
 */
function loadCommonJs (filename) {
  const cached = require.cache[filename]

  let exports
  if (cached && !cached.loaded) {
    Module.prototype._compile.call(cached, readFileSync(filename, 'utf8'), filename)
    cached.loaded = true
    exports = cached.exports
  } else if (cached) {
    exports = cached.exports
  } else {
    // An `import` of a CommonJS file: load it through require so hooks and the cache are shared.
    const parent = new Module(filename)
    parent.filename = filename
    parent.paths = Module._nodeModulePaths(path.dirname(filename))
    exports = Module.prototype.require.call(parent, filename)
  }

  return { loader: 'js', contents: getCommonJsFacade(filename, exports) }
}

/**
 * The facade keeps live bindings: a module first evaluated for `require()` is reused by a later
 * `import`, which must observe the exports as replaced by require hooks.
 *
 * @param {string} filename
 * @param {unknown} exports
 */
function getCommonJsFacade (filename, exports) {
  const states = globalThis[EXPORTS_KEY]
  let state = states.get(filename)
  if (state) {
    state.exports = exports
    state.update?.(exports)
  } else {
    state = { exports, update: undefined }
    states.set(filename, state)
  }

  let declarations = 'let exports = state.exports'
  let updates = 'exports = value'
  let specifiers = 'exports as default, exports as "module.exports"'

  if (exports !== null && (typeof exports === 'object' || typeof exports === 'function')) {
    let index = 0
    for (const name of Object.keys(exports)) {
      if (name === 'default' || name === 'module.exports') continue
      const key = JSON.stringify(name)
      declarations += `, $${index} = exports[${key}]`
      updates += `; $${index} = value[${key}]`
      specifiers += `, $${index++} as ${key}`
    }
  }

  return `const state = globalThis[Symbol.for('dd-trace.bun.commonjs-exports')].get(${JSON.stringify(filename)})
${declarations}
state.update = (value) => { ${updates} }
export { ${specifiers} }
`
}

/**
 * @param {string} filename
 * @returns {string | undefined}
 */
function wrap (filename) {
  const url = pathToFileURL(filename).href
  const originalUrl = url + ORIGINAL_QUERY

  const resolve = (specifier, context) => {
    if (specifier === url || specifier === getSpecifier(filename)) return { url: originalUrl, format: 'module' }

    const resolved = specifier.startsWith('file:')
      ? fileURLToPath(specifier)
      : globalThis.Bun.resolveSync(specifier, path.dirname(fileURLToPath(context.parentURL)))

    return { url: pathToFileURL(resolved).href, format: getFormat(resolved) }
  }

  const context = { parentURL: PARENT_URL, conditions: ['import'] }
  const result = iitmHook.resolveSync(getSpecifier(filename), context, resolve)
  if (result.url === originalUrl) return

  const loaded = iitmHook.loadSync(result.url, { format: 'module', conditions: ['import'] }, (loadUrl, context) => {
    const loadPath = fileURLToPath(loadUrl)
    return { source: readFileSync(loadPath, 'utf8'), format: context?.format ?? getFormat(loadPath) }
  })

  if (typeof loaded.source !== 'string') return

  return loaded.source.replace(
    `import * as namespace from ${JSON.stringify(originalUrl)}`,
    `import * as namespace from ${JSON.stringify(filename + ORIGINAL_QUERY)}`
  )
}

/**
 * @param {string} filename
 */
function rewrite (filename) {
  const source = readFileSync(filename, 'utf8')
  const result = rewriterLoader.loadSync(pathToFileURL(filename).href, { format: 'module' }, () => {
    return { source, format: 'module' }
  })

  return result.source
}

/**
 * Returns the bare package specifier when the file is the entrypoint of its package, so hooks
 * registered for the package name apply, otherwise the file URL.
 *
 * @param {string} filename
 */
function getSpecifier (filename) {
  let specifier = packageSpecifiers.get(filename)
  if (specifier !== undefined) return specifier

  specifier = pathToFileURL(filename).href
  const details = moduleDetailsFromPath(filename)
  if (details) {
    try {
      if (globalThis.Bun.resolveSync(details.name, details.basedir) === filename) specifier = details.name
    } catch {}
  }

  packageSpecifiers.set(filename, specifier)
  return specifier
}

/**
 * @param {string} filename
 * @returns {'module' | 'commonjs'}
 */
function getFormat (filename) {
  if (filename.endsWith('.mjs')) return 'module'
  if (filename.endsWith('.cjs')) return 'commonjs'

  return getPackageType(path.dirname(filename))
}

/**
 * @param {string} directory
 * @returns {'module' | 'commonjs'}
 */
function getPackageType (directory) {
  let type = packageTypes.get(directory)
  if (type !== undefined) return type

  type = 'commonjs'
  try {
    const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'))
    if (manifest.type === 'module') type = 'module'
  } catch {
    const parent = path.dirname(directory)
    if (parent !== directory && path.basename(directory) !== 'node_modules') type = getPackageType(parent)
  }

  packageTypes.set(directory, type)
  return type
}

module.exports = { register }
