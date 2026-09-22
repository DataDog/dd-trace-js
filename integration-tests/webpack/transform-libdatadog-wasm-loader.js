'use strict'

/**
 * @param {string} source
 */
module.exports = function transformLibdatadogWasmLoader (source) {
  const transformed = source.replace(
    '/* @datadog/wasm-asset */',
    '/* marker consumed before configured loader */'
  )
  return `/* configured libdatadog loader ran */\n${transformed}`
}
