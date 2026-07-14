'use strict'

const CHANNEL = 'dd-trace:bundler:load'

/**
 * Webpack loader that appends a dc-polyfill channel publish to a CJS module.
 * Called for each module-of-interest identified by DatadogWebpackPlugin.
 *
 * @param {string} source
 * @returns {string}
 */
module.exports = function loader (source) {
  this.cacheable(false)
  const { pkg, version, path: pkgPath } = this.getOptions()

  return (
    source +
    '\n;{\n' +
    '  const __dd_dc = require(\'dc-polyfill\');\n' +
    `  const __dd_ch = __dd_dc.channel('${CHANNEL}');\n` +
    '  const __dd_mod = module.exports;\n' +
    `  const __dd_payload = { module: __dd_mod, version: '${version}', package: '${pkg}', path: '${pkgPath}' };\n` +
    '  __dd_ch.publish(__dd_payload);\n' +
    '  module.exports = __dd_payload.module;\n' +
    '}\n'
  )
}
