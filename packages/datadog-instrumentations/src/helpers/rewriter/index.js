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

const supported = {}
const disabled = new Set()
const sourceMaps = {}

let parse
let generate
let esquery
let sourceMapSupport

function rewrite (content, filename, format) {
  if (!content) return content

  try {
    let ast

    filename = filename.replace('file://', '')

    for (const inst of instrumentations) {
      const { astQuery, moduleName, versionRange, filePath, operator, functionQuery } = inst
      const transform = transforms[operator]

      if (disabled.has(moduleName)) continue
      if (!filename.endsWith(`${moduleName}/${filePath}`)) continue
      if (!transform) continue
      if (!satisfies(filename, filePath, versionRange)) continue

      parse ??= require('meriyah').parse
      generate ??= require('escodegen').generate
      esquery ??= require('esquery')

      if (!sourceMapSupport) {
        // Use an alias to ensure we have our own instance, otherwise there
        // could be an existing user instance and the library doesn't support
        // multiple calls to `install`.
        sourceMapSupport = require('@datadog/source-map-support')
        sourceMapSupport.install({
          retrieveSourceMap: function (url) {
            const map = sourceMaps[url]
            return map ? { url, map } : null
          }
        })
      }

      ast ??= parse(content.toString(), { loc: true, ranges: true, module: format === 'module' })

      const query = astQuery || fromFunctionQuery(functionQuery)
      const selector = esquery.parse(query)
      const state = { ...inst, format }

      esquery.traverse(ast, selector, (...args) => transform(state, ...args))
    }

    if (ast) {
      const { code, map } = generate(ast, { sourceMap: filename, sourceMapWithCode: true })

      sourceMaps[filename] = map.toString()

      return code
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
  const kind = functionQuery.kind?.toLowerCase()

  let queries = []

  if (className) {
    queries.push(
      `[id.name="${className}"]`,
      `[id.name="${className}"] > ClassBody > [key.name="${methodName}"] > [async]`
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

  if (kind) {
    queries = queries.map(q => q.replaceAll('[async]', `[async="${kind === 'async' ? 'true' : 'false'}"]`))
  }

  return queries.join(', ')
}

module.exports = { rewrite, disable }
