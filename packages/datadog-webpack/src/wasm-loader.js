'use strict'

const { inlineLibdatadogWasmAssets } = require('../../datadog-esbuild/src/libdatadog-wasm')

/**
 * @param {string} source
 */
module.exports = function inlineLibdatadogWasm (source) {
  this.cacheable()
  const result = inlineLibdatadogWasmAssets(source, this.resourcePath)
  if (!result) return source

  for (const asset of result.assets) {
    this.addDependency(asset)
  }
  return result.contents
}
