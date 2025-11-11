'use strict'

// The rewriter works effectively the same as Orchestrion with some additions:
// - Supports an `astQuery` field to filter AST nodes with an esquery query.

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

const swc = require('@swc/core')

console.time('test')

swc.parseSync('console.log("hello")', { syntax: 'ecmascript' })

console.timeEnd('test')

function rewrite (content, filename, format) {
  if (!content) return content

  try {
    let ast

    filename = filename.replace('file://', '')

    for (const inst of instrumentations) {
      const { astQuery, moduleName, versionRange, filePath, channelName } = inst
      const transform = transforms[inst.operator]

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

      try {
        ast ??= parse(content.toString(), { loc: true, ranges: true, module: format === 'module' })
      } catch (e) {
        log.error(e)
      }

      const query = astQuery || functionQuery(inst)
      const selector = esquery.parse(query)
      const state = { channelName, format, moduleName }

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
function functionQuery (inst) {
  const { functionQuery } = inst
  const { methodName, functionName, expressionName, className } = functionQuery
  const kind = functionQuery.kind?.toLowerCase()

  let queries = []

  if (className) {
    queries.push(
      `[id.name="${className}"] > ClassBody > [key.name="${methodName}"] > [async]`
    )
  } else if (methodName) {
    queries.push(
      `ClassBody > [key.name="${methodName}"] > [async]`,
      `Property[key.name="${methodName}"] > [async]`
    )
  }

  if (functionName) {
    queries.push(`FunctionDeclaration[id.name="${functionName}"]`)
  } else if (expressionName) {
    queries.push(
      `FunctionExpression[id.name="${expressionName}"]`,
      `ArrowFunctionExpression[id.name="${expressionName}"]`
    )
  }

  if (kind) {
    queries = queries.map(q => `${q}[async="${kind === 'async' ? 'true' : 'false'}"]`)
  }

  return queries.join(', ')
}

module.exports = { rewrite, disable }
