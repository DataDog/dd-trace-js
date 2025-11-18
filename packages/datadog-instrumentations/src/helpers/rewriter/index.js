'use strict'

// The rewriter works effectively the same as Orchestrion with some additions:
// - Supports an `astQuery` field to filter AST nodes with an esquery query.
// - Supports replacing methods of child class instance in the base constructor.

const { readFileSync } = require('fs')
const { join } = require('path')
const semifies = require('semifies')
const transforms = require('./transforms')
const log = require('../../../../dd-trace/src/log')
const instrumentations = require('./instrumentations.json')
const { getEnvironmentVariable } = require('../../../../dd-trace/src/config-helper')

const NODE_OPTIONS = getEnvironmentVariable('NODE_OPTIONS')

const supported = {}
const disabled = new Set()

// TODO: Source maps without `--enable-source-maps`.
const enableSourceMaps = NODE_OPTIONS?.includes('--enable-source-maps') ||
  process.execArgv?.some(arg => arg.includes('--enable-source-maps'))

let parse
let generate
let esquery
let SourceMapGenerator

function rewrite (content, filename, format) {
  if (!content) return content

  try {
    let ast

    filename = filename.replace('file://', '')

    for (const inst of instrumentations) {
      const { astQuery, functionQuery = {}, module: { name, versionRange, filePath } } = inst
      const { kind } = functionQuery
      const operator = kind === 'Async' ? 'tracePromise' : 'traceSync' // TODO: traceCallback
      const transform = transforms[operator]

      if (disabled.has(name)) continue
      if (!filename.endsWith(`${name}/${filePath}`)) continue
      if (!transform) continue
      if (!satisfies(filename, filePath, versionRange)) continue

      parse ??= require('meriyah').parse
      generate ??= require('astring').generate
      esquery ??= require('esquery')

      ast ??= parse(content.toString(), { loc: true, ranges: true, module: format === 'module' })

      const query = astQuery || fromFunctionQuery(functionQuery)
      const selector = esquery.parse(query)
      const state = { ...inst, format, operator }

      esquery.traverse(ast, selector, (...args) => transform(state, ...args))
    }

    if (ast) {
      if (!enableSourceMaps || SourceMapGenerator) return generate(ast)

      // TODO: Can we use the same version of `source-map` that DI uses?
      SourceMapGenerator ??= require('@datadog/source-map').SourceMapGenerator

      const sourceMap = new SourceMapGenerator({ file: filename })
      const code = generate(ast, { sourceMap })
      const map = Buffer.from(sourceMap.toString()).toString('base64')

      return code + '\n' + `//# sourceMappingURL=data:application/json;base64,${map}`
    }
  } catch (e) {
    log.error(e)
  }

  return content
}

function disable (instrumentation) {
  disabled.add(instrumentation)
}

function satisfies (filename, filePath, versions) {
  const [basename] = filename.split(filePath)

  if (supported[basename] === undefined) {
    try {
      const pkg = JSON.parse(readFileSync(
        join(basename, 'package.json'), 'utf8'
      ))

      supported[basename] = semifies(pkg.version, versions)
    } catch {
      supported[basename] = false
    }
  }

  return supported[basename]
}

// TODO: Support index
function fromFunctionQuery (functionQuery) {
  const { methodName, functionName, expressionName, className } = functionQuery
  const queries = []

  if (className) {
    queries.push(
      `[id.name="${className}"]`,
      `[id.name="${className}"] > ClassBody > [key.name="${methodName}"] > [async]`,
      `[id.name="${className}"] > ClassExpression > ClassBody > [key.name="${methodName}"] > [async]`
    )
  } else if (methodName) {
    queries.push(
      `ClassBody > [key.name="${methodName}"] > [async]`,
      `Property[key.name="${methodName}"] > [async]`
    )
  }

  if (functionName) {
    queries.push(`FunctionDeclaration[id.name="${functionName}"][async]`)
  } else if (expressionName) {
    queries.push(
      `FunctionExpression[id.name="${expressionName}"][async]`,
      `ArrowFunctionExpression[id.name="${expressionName}"][async]`
    )
  }

  return queries.join(', ')
}

module.exports = { rewrite, disable }
