'use strict'

const fs = require('node:fs')
const { builtinModules } = require('node:module')
const path = require('node:path')
const { fileURLToPath, pathToFileURL } = require('node:url')

const { createWrapperModule, getNodeModuleFormat } = require('import-in-the-middle/bundler')

const ORIGINAL_QUERY = '?__dd_iitm_original__'
const builtins = new Set(builtinModules)

/**
 * @param {string} url
 * @param {{ format?: string }} context
 * @returns {{ source?: Buffer, format?: string, watchFiles?: string[] }}
 */
function loadModule (url, context) {
  if (!url.startsWith('file:')) return { format: context.format }

  const filename = fileURLToPath(url)
  return {
    source: fs.readFileSync(filename),
    format: context.format ?? getNodeModuleFormat(url) ?? 'commonjs',
    watchFiles: [url],
  }
}

/**
 * @param {string|Buffer} source
 * @returns {Promise<string>}
 */
module.exports = async function loader (source) {
  this.cacheable(false)
  const options = this.getOptions()

  /**
   * @param {string} specifier
   * @param {{ parentURL?: string }} context
   */
  const resolve = async (specifier, context) => {
    if (specifier.startsWith('node:') || builtins.has(specifier)) {
      return { url: specifier, format: 'builtin' }
    }

    const parentPath = context.parentURL?.startsWith('file:')
      ? fileURLToPath(context.parentURL)
      : this.resourcePath
    const resolved = await this.getResolve({ dependencyType: 'esm' })(path.dirname(parentPath), specifier)
    const builtin = resolved.startsWith('node:') || builtins.has(resolved)
    const url = builtin ? resolved : pathToFileURL(resolved).href
    return {
      url,
      format: getNodeModuleFormat(url) ?? 'commonjs',
      watchFiles: path.isAbsolute(resolved) ? [pathToFileURL(resolved).href] : undefined,
    }
  }

  const wrapper = await createWrapperModule({
    module: {
      url: options.url,
      format: options.format,
      source,
      specifier: options.specifier,
      data: { version: options.version },
    },
    resolve,
    load: loadModule,
  })

  let code = wrapper.code
  for (const entry of wrapper.imports) {
    const target = entry.external
      ? entry.target.url
      : `${fileURLToPath(entry.target.url)}${entry.kind === 'module' ? ORIGINAL_QUERY : ''}`
    code = code.replaceAll(JSON.stringify(entry.specifier), JSON.stringify(target))
  }
  for (const watchFile of wrapper.watchFiles) {
    if (watchFile.startsWith('file:')) this.addDependency(fileURLToPath(watchFile))
  }
  return code
}

module.exports.ORIGINAL_QUERY = ORIGINAL_QUERY
