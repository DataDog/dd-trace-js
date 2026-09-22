'use strict'

const fs = require('node:fs')
const path = require('node:path')

const LIBDATADOG_WASM_PACKAGE = '@datadog/libdatadog-wasm'
const WASM_ASSET_MARKER = '/* @datadog/wasm-asset */'
const WASM_ASSET_PATTERN =
  /\/\* @datadog\/wasm-asset \*\/ require\('node:fs'\)\.readFileSync\(`\$\{__dirname\}\/([\w-]+_bg\.wasm\.br)`\)/g

/**
 * @param {string} source
 * @param {string} resourcePath
 */
function inlineLibdatadogWasmAssets (source, resourcePath) {
  const assets = []
  WASM_ASSET_PATTERN.lastIndex = 0

  /**
   * @param {string} _matchedLoader
   * @param {string} filename
   */
  function replaceAsset (_matchedLoader, filename) {
    const assetPath = path.join(path.dirname(resourcePath), filename)
    const encoded = fs.readFileSync(assetPath).toString('base64')
    assets.push(assetPath)
    return `Buffer.from(${JSON.stringify(encoded)}, 'base64')`
  }

  const contents = source.replace(WASM_ASSET_PATTERN, replaceAsset)

  if (assets.length > 0) return { assets, contents }

  if (source.includes(WASM_ASSET_MARKER) || source.includes('_bg.wasm.br')) {
    throw new Error(`Unsupported ${LIBDATADOG_WASM_PACKAGE} asset loader in ${resourcePath}`)
  }
}

module.exports = {
  LIBDATADOG_WASM_PACKAGE,
  inlineLibdatadogWasmAssets,
}
