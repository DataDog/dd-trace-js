'use strict'

const { filename } = require('../../datadog-instrumentations/src/helpers/instrumentation-utils')
const { createBundlerRewriter } = require('../../datadog-instrumentations/src/helpers/rewriter')
const { getRewriteTarget } = require('../../datadog-instrumentations/src/helpers/rewriter/targets')

const CHANNEL = 'dd-trace:bundler:load'
// Resolved from dd-trace so the injected require works even when dc-polyfill is not hoisted next to the target.
const DC_MODULE = require.resolve('dc-polyfill').replaceAll('\\', '/')
const DC_MODULE_LITERAL = JSON.stringify(DC_MODULE)

let rewrite

/**
 * Webpack loader called for each module-of-interest identified by DatadogWebpackPlugin.
 * Orchestrion rewrite targets are rewritten and, for pure Orchestrion integrations, get an activation publish
 * appended. Modules with export hooks get a dc-polyfill channel publish of their CJS exports appended.
 *
 * @param {string} source
 * @param {string|object} [inputSourceMap]
 */
module.exports = function loader (source, inputSourceMap) {
  this.cacheable(false)
  const { pkg, version, path: pkgPath, rewriteOnly } = this.getOptions()
  const target = getRewriteTarget(this.resourcePath.replaceAll('\\', '/'))

  let code = source
  let map = inputSourceMap

  if (target) {
    rewrite ??= createBundlerRewriter(DC_MODULE)
    const result = rewrite(source, this.resourcePath, 'commonjs', target, inputSourceMap)
    code = result.code
    map = result.map

    if (code !== source && target.activate) {
      const payload = JSON.stringify({
        activate: true,
        package: target.moduleName,
        version,
        path: filename(target.moduleName, target.filePath),
      })
      this.callback(
        null,
        `${code}\n;{\n` +
        `  const __dd_ch = require(${DC_MODULE_LITERAL}).channel('${CHANNEL}');\n` +
        `  if (__dd_ch.hasSubscribers) __dd_ch.publish(${payload});\n` +
        '}\n',
        map
      )
      return
    }
  }

  // Rewrite-only targets have no export hook, so publishing their exports would only report a missing hook.
  if (rewriteOnly) {
    this.callback(null, code, map)
    return
  }

  this.callback(
    null,
    code +
    '\n;{\n' +
    `  const __dd_dc = require(${DC_MODULE_LITERAL});\n` +
    `  const __dd_ch = __dd_dc.channel('${CHANNEL}');\n` +
    '  const __dd_mod = module.exports;\n' +
    `  const __dd_payload = { module: __dd_mod, version: '${version}', package: '${pkg}', path: '${pkgPath}' };\n` +
    '  __dd_ch.publish(__dd_payload);\n' +
    '  module.exports = __dd_payload.module;\n' +
    '}\n',
    map
  )
}
