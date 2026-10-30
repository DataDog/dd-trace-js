'use strict'

const fs = require('node:fs')

const { instrument } = require('../../datadog-instrumentations/src/helpers/bundler-transform')
const { SYNTHETIC_EXTENSION } = require('./constants')

/**
 * @typedef {object} LoaderContext
 * @property {(error: Error|undefined, code?: string, sourceMap?: string|object) => void} callback
 * @property {(warning: Error) => void} [emitWarning]
 * @property {string} resourcePath
 */

/**
 * Instruments a resolved foreign Node.js module.
 *
 * @this {LoaderContext}
 * @param {string} source
 * @param {string|object} [inputSourceMap]
 */
module.exports = function loader (source, inputSourceMap) {
  let result
  try {
    result = instrument({
      source,
      resourcePath: getResourcePath(this),
      inputSourceMap,
      warn: this.emitWarning?.bind(this),
    })
  } catch (error) {
    try {
      this.emitWarning?.(error instanceof Error ? error : new Error(String(error)))
    } catch {
      // A warning must not prevent the loader from returning the original source.
    }
  }
  this.callback(undefined, result?.code ?? source, result ? result.map : inputSourceMap)
}

/**
 * @param {LoaderContext} context
 */
function getResourcePath (context) {
  const { resourcePath } = context
  if (!resourcePath.endsWith(SYNTHETIC_EXTENSION) || fs.existsSync(resourcePath)) return resourcePath

  const extensionlessPath = resourcePath.slice(0, -SYNTHETIC_EXTENSION.length)
  return fs.existsSync(extensionlessPath) ? extensionlessPath : resourcePath
}
