'use strict'

// Generates the ESM wrapper module (facade) that registers a bundled ES module or builtin with the IITM export
// hooks, using the experimental `import-in-the-middle/wrapper.mjs` API. The bundler plugin supplies module
// resolution and resolves the wrapper's placeholder imports with the returned targets.
const fs = require('node:fs')
const { builtinModules } = require('node:module')
const { fileURLToPath, pathToFileURL } = require('node:url')

const builtins = new Set(builtinModules)

/**
 * How the bundler resolves a re-export of an analyzed module: the module's path, or a builtin name, and for a module
 * the bundle keeps external, the module ID the bundle emits for it.
 *
 * @typedef {{ path: string, external?: string }} ResolvedReexport
 */
/**
 * @typedef {(specifier: string, importer: string, kind: 'import' | 'require') => Promise<ResolvedReexport>
 * } ResolveReexport
 */
/**
 * What a placeholder import of the wrapper resolves to. `external` targets stay out of the bundle. Otherwise `kind`
 * tells the plugin how to resolve `path`: `runtime` is IITM's registration runtime, `original` is the wrapped module
 * and must load unwrapped, and `module` defines a re-exported name and resolves as it does from the wrapped module.
 *
 * @typedef {{ path: string, external: true } | { path: string, kind: 'runtime' | 'original' | 'module' }
 * } WrapperImportTarget
 */

let wrapperModule

function loadWrapperModule () {
  wrapperModule ??= import('import-in-the-middle/wrapper.mjs')
  return wrapperModule
}

/**
 * @param {string} name A builtin name, with or without the `node:` prefix.
 */
function isBuiltin (name) {
  return name.startsWith('node:') || builtins.has(name)
}

/**
 * @param {string} name A builtin name, with or without the `node:` prefix.
 * @returns {`node:${string}`}
 */
function toBuiltinUrl (name) {
  return /** @type {`node:${string}`} */ (name.startsWith('node:') ? name : `node:${name}`)
}

/**
 * Generates the wrapper for an ES module file or a builtin.
 *
 * @param {object} options
 * @param {string} options.path The wrapped module's path, or the builtin's name.
 * @param {boolean} [options.internal] Whether `path` names a builtin.
 * @param {string} options.specifier The specifier the module is imported by, reported to the hooks.
 * @param {ResolveReexport} options.resolve Resolves re-exports the way the bundle does.
 * @returns {Promise<{ code: string, imports: Map<string, WrapperImportTarget>, watchFiles: string[] }>}
 */
async function createEsmWrapper ({ path: filename, internal, specifier, resolve }) {
  const { createWrapperModule } = await loadWrapperModule()
  /** @type {Set<string>} */
  const watchFiles = new Set()
  /**
   * Re-exported modules the bundle keeps external, by URL, with the module ID the bundle emits for them.
   *
   * @type {Map<string, string>}
   */
  const externals = new Map()

  let wrapper
  if (internal) {
    wrapper = await createWrapperModule({ url: toBuiltinUrl(filename), specifier })
  } else {
    watchFiles.add(filename)
    wrapper = await createWrapperModule({
      url: pathToFileURL(filename).href,
      source: fs.readFileSync(filename, 'utf8'),
      specifier,
      async resolve (request, { parentURL, kind }) {
        const result = await resolve(request, fileURLToPath(parentURL), kind)
        if (isBuiltin(result.path)) return { url: toBuiltinUrl(result.path), format: 'builtin' }
        const url = pathToFileURL(result.path).href
        if (result.external !== undefined) externals.set(url, result.external)
        return { url }
      },
      load (url) {
        const modulePath = fileURLToPath(url)
        // The wrapper's export list depends on every module analyzed for it, even those it never imports.
        watchFiles.add(modulePath)
        // IITM tells ESM from CommonJS by the module's syntax.
        return { source: fs.readFileSync(modulePath, 'utf8') }
      },
    })
  }

  /** @type {Map<string, WrapperImportTarget>} */
  const imports = new Map()
  for (const { specifier: placeholder, kind, url, format } of wrapper.imports) {
    const external = externals.get(url)
    if (format === 'builtin') {
      imports.set(placeholder, { path: url, external: true })
    } else if (external === undefined) {
      imports.set(placeholder, { path: fileURLToPath(url), kind })
    } else {
      imports.set(placeholder, { path: external, external: true })
    }
  }

  return { code: wrapper.code, imports, watchFiles: [...watchFiles] }
}

module.exports = { createEsmWrapper }
