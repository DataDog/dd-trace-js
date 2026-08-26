'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { create } = require('../../../vendor/dist/@apm-js-collab/code-transformer')
const { isESMFile } = require('../../datadog-esbuild/src/utils')

const CHANNEL = 'dd-trace:bundler:load'

/**
 * Instruments bundled modules known to dd-trace. CommonJS modules publish
 * through the existing bundler channel. ESM modules instead rewrite only
 * imports that resolve to generated live-binding proxies.
 *
 * @param {string} source
 * @returns {string}
 */
module.exports = function loader (source) {
  const { manifestPath } = this.getOptions()
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const target = manifest.targets[normalizePath(this.resourcePath)]

  if (isESMFile(this.resourcePath)) {
    return rewriteImports(source, this.resourcePath, manifest.targets)
  }

  if (!target) return source

  const dcPolyfillPath = relativeImport(
    path.dirname(this.resourcePath),
    require.resolve('dc-polyfill')
  )

  return `${source}
;{
  const __dd_dc = require(${JSON.stringify(dcPolyfillPath)})
  const __dd_ch = __dd_dc.channel('${CHANNEL}')
  const __dd_payload = {
    module: module.exports,
    version: ${JSON.stringify(target.version)},
    package: ${JSON.stringify(target.name)},
    path: ${JSON.stringify(target.path)},
  }
  __dd_ch.publish(__dd_payload)
  module.exports = __dd_payload.module
}
`
}

/**
 * @param {string} source
 * @param {string} resourcePath
 * @param {Record<string, {esm: boolean, proxyPath?: string}>} targets
 * @returns {string}
 */
function rewriteImports (source, resourcePath, targets) {
  resourcePath = normalizePath(resourcePath)
  let rewritten = false
  const matcher = create([{
    module: { name: 'dd-trace-turbopack', versionRange: '*', filePath: /.*/ },
    astQuery: 'Program',
    transform: 'rewriteImports',
  }])

  matcher.addTransform('rewriteImports', (_state, program) => {
    visit(program, node => {
      if (!isModuleSource(node)) return

      const resolved = resolveFrom(resourcePath, node.source.value)
      const target = resolved && targets[resolved]
      if (!target?.esm || !target.proxyPath) return

      const proxySpecifier = relativeImport(path.dirname(resourcePath), target.proxyPath)
      // The code transformer emits `raw` when present, so update both fields.
      node.source.value = proxySpecifier
      node.source.raw = JSON.stringify(proxySpecifier)
      rewritten = true
    })
  })

  const transformer = matcher.getTransformer('dd-trace-turbopack', '1.0.0', resourcePath)
  if (!transformer) return source

  try {
    const output = transformer.transform(source, 'esm').code
    return rewritten ? output : source
  } catch {
    // A parser failure must never prevent an application from building.
    return source
  }
}

function isModuleSource (node) {
  return (node.type === 'ImportDeclaration' ||
    node.type === 'ExportNamedDeclaration' ||
    node.type === 'ExportAllDeclaration' ||
    node.type === 'ImportExpression') &&
    node.source?.type === 'Literal' && typeof node.source.value === 'string'
}

function visit (node, callback) {
  if (!node || typeof node !== 'object') return
  callback(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => visit(child, callback))
    else visit(value, callback)
  }
}

function resolveFrom (resourcePath, specifier) {
  try {
    return normalizePath(require.resolve(specifier, {
      paths: [path.dirname(resourcePath)],
      conditions: new Set(['import', 'node']),
    }))
  } catch {}
}

function relativeImport (from, to) {
  let value = path.relative(from, to).replaceAll('\\', '/')
  if (!value.startsWith('.')) value = `./${value}`
  return value
}

function normalizePath (value) {
  return fs.realpathSync(value).replaceAll('\\', '/')
}

module.exports.rewriteImports = rewriteImports
