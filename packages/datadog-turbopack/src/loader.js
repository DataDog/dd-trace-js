'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { create } = require('../../../vendor/dist/@apm-js-collab/code-transformer')
const { isESMFile, resolveModule } = require('../../datadog-esbuild/src/utils')
const { rewrite } = require('../../datadog-instrumentations/src/helpers/rewriter')

const CHANNEL = 'dd-trace:bundler:load'
// Keep the marker split so source-map scanners do not treat this file as mapped.
// eslint-disable-next-line unicorn/no-useless-concat -- Keep the marker non-contiguous.
const SOURCE_MAP_PREFIX = '//# sourceMapping' + 'URL=data:application/json;base64,'
const manifestCache = new Map()

/**
 * Instruments bundled modules known to dd-trace. CommonJS modules publish
 * through the existing bundler channel. ESM modules instead rewrite only
 * imports that resolve to generated live-binding proxies.
 *
 * @param {string} source
 * @returns {string}
 */
module.exports = function loader (source) {
  const { aliases, manifestPath, rewriteApplicationImports } = this.getOptions()
  let manifest = manifestCache.get(manifestPath)
  if (!manifest) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifestCache.set(manifestPath, manifest)
  }
  const target = manifest.targets[normalizePath(this.resourcePath)] ||
    getRelativeTarget(this.resourcePath, manifest.relativeTargets)
  if (!target && !rewriteApplicationImports && !manifest.esmImportPattern?.test(source)) return source

  const esm = isESMFile(this.resourcePath)

  if (rewriteApplicationImports || (esm && manifest.esmImportPattern?.test(source))) {
    source = rewriteImports(source, this.resourcePath, manifest.targets, aliases)
  }

  if (!target) return source

  const rewriteTarget = target.esm === undefined
    ? undefined
    : {
        moduleName: target.name,
        filePath: target.moduleBaseDir
          ? path.relative(target.moduleBaseDir, normalizePath(this.resourcePath)).replaceAll('\\', '/')
          : target.path.slice(target.name.length + 1),
      }
  source = rewrite(source, this.resourcePath, esm ? 'module' : 'commonjs', rewriteTarget, true)
  if (esm) return source

  return `${source}
;{
  const __dd_ch = require('node:diagnostics_channel').channel('${CHANNEL}')
  const __dd_payload = {
    module: module.exports,
    moduleBaseDir: ${JSON.stringify(target.moduleBaseDir)},
    moduleName: ${JSON.stringify(this.resourcePath)},
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
 * @param {string[]} [aliases]
 * @returns {string}
 */
function rewriteImports (source, resourcePath, targets, aliases = []) {
  resourcePath = normalizePath(resourcePath)
  let rewritten = false
  const matcher = create([{
    module: { name: 'dd-trace-turbopack', versionRange: '*', filePath: /.*/ },
    astQuery: 'Program',
    transform: 'rewriteImports',
  }])

  matcher.addTransform('rewriteImports', (_state, program) => {
    const hasLocalRequire = declaresRequire(program)
    visit(program, node => {
      const source = getModuleSource(node, hasLocalRequire)

      if (!source || matchesAlias(source.value, aliases)) return

      let resolved
      try {
        resolved = normalizePath(resolveModule(source.value, path.dirname(resourcePath), true))
      } catch {}
      const target = resolved && targets[resolved]
      if (!target?.esm || !target.proxyPath) return

      const proxySpecifier = relativeImport(path.dirname(resourcePath), target.proxyPath)
      // The code transformer emits `raw` when present, so update both fields.
      source.value = proxySpecifier
      source.raw = JSON.stringify(proxySpecifier)
      rewritten = true
    })
  })

  const transformer = matcher.getTransformer('dd-trace-turbopack', '1.0.0', resourcePath)
  if (!transformer) return source

  try {
    const { code, map } = transformer.transform(source, 'esm')
    return rewritten ? withInlineSourceMap(code, map) : source
  } catch {
    // A parser failure must never prevent an application from building.
    return source
  }
}

function withInlineSourceMap (code, map) {
  if (!map) return code
  return `${code}\n${SOURCE_MAP_PREFIX}${Buffer.from(map).toString('base64')}`
}

function getModuleSource (node, hasLocalRequire) {
  if (node.type === 'ImportDeclaration' ||
    node.type === 'ExportNamedDeclaration' ||
    node.type === 'ExportAllDeclaration' ||
    node.type === 'ImportExpression') {
    return isStringLiteral(node.source) && node.source
  }

  if (node.type === 'CallExpression' &&
    node.callee?.type === 'Identifier' && node.callee.name === 'require' &&
    node.arguments?.length === 1) {
    return !hasLocalRequire && isStringLiteral(node.arguments[0]) && node.arguments[0]
  }
}

function matchesAlias (specifier, aliases) {
  return aliases.some(alias => specifier === alias || specifier.startsWith(`${alias}/`))
}

function getRelativeTarget (resourcePath, targets = []) {
  const normalizedPath = normalizePath(resourcePath)
  return targets.find(target => normalizedPath.endsWith(`/${target.file}`))
}

// We deliberately decline all CommonJS rewrites in a file with a lexical
// `require` binding. Rewriting an application-defined function is worse than
// leaving an uncommon module load uninstrumented.
function declaresRequire (node) {
  let declared = false
  visit(node, child => {
    if (child.type === 'VariableDeclarator' || child.type === 'CatchClause') {
      declared ||= bindingIncludesRequire(child.id ?? child.param)
    } else if (child.type === 'FunctionDeclaration' ||
      child.type === 'FunctionExpression' || child.type === 'ArrowFunctionExpression') {
      declared ||= child.params.some(bindingIncludesRequire) || child.id?.name === 'require'
    } else if (child.type === 'ImportSpecifier' || child.type === 'ImportDefaultSpecifier' ||
      child.type === 'ImportNamespaceSpecifier') {
      declared ||= child.local?.name === 'require'
    } else if (child.type === 'ClassDeclaration') {
      declared ||= child.id?.name === 'require'
    }
  })
  return declared
}

function bindingIncludesRequire (node) {
  if (!node || typeof node !== 'object') return false
  if (node.type === 'Identifier') return node.name === 'require'
  if (node.type === 'RestElement' || node.type === 'AssignmentPattern') {
    return bindingIncludesRequire(node.argument ?? node.left)
  }
  if (node.type === 'ArrayPattern') return node.elements.some(bindingIncludesRequire)
  if (node.type === 'ObjectPattern') {
    return node.properties.some(property => property.type === 'RestElement'
      ? bindingIncludesRequire(property)
      : bindingIncludesRequire(property.value))
  }
  return false
}

function isStringLiteral (node) {
  return node?.type === 'Literal' && typeof node.value === 'string'
}

function visit (node, callback) {
  if (!node || typeof node !== 'object') return
  callback(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => visit(child, callback))
    else visit(value, callback)
  }
}

function relativeImport (from, to) {
  const value = path.relative(from, to)
  if (path.isAbsolute(value)) throw new Error('Cannot create a relative import across filesystem volumes')

  const normalized = value.replaceAll('\\', '/')
  return normalized.startsWith('.') ? normalized : `./${normalized}`
}

function normalizePath (value) {
  return fs.realpathSync(value).replaceAll('\\', '/')
}

module.exports.rewriteImports = rewriteImports
