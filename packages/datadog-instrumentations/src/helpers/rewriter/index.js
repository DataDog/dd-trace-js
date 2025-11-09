'use strict'

// The rewriter works effectively the same as Orchestrion with some additions:
// - Supports an `engines` field to filter a Node version range.
// - Supports an `astQuery` field to filter AST nodes with an esquery query.

const { parse } = require('meriyah')
const { generate } = require('astring')
const esquery = require('esquery')
const { readFileSync } = require('fs')
const { join } = require('path')
const semifies = require('semifies')
const transforms = require('./transforms')
const instrumentations = require('./instrumentations.json')

const NODE_VERSION = process.versions.node

const supported = {}
const disabled = new Set()

function rewrite (content, filename, format) {
  if (!content) return content

  let ast

  for (const inst of instrumentations) {
    const { astQuery, moduleName, versionRange, filePath, channelName, engines } = inst
    const transform = transforms[inst.operator]

    if (disabled.has(moduleName)) continue
    if (!filename.endsWith(`${moduleName}/${filePath}`)) continue
    if (!transform) continue
    if (engines && !semifies(NODE_VERSION, engines)) continue
    if (!satisfies(filename, filePath, versionRange)) continue

    ast ??= parse(content.toString(), { loc: true, module: format === 'module' })

    const query = astQuery || functionQuery(inst)
    const selector = esquery.parse(query)
    const state = { channelName, format, moduleName }

    esquery.traverse(ast, selector, (...args) => transform(state, ...args))
  }

  return ast ? generate(ast) : content
}

function disable (instrumentation) {
  disabled.add(instrumentation)
}

function satisfies (filename, filePath, versions) {
  const [basename] = filename.split(filePath)

  if (supported[basename] === undefined) {
    try {
      const pkg = JSON.parse(readFileSync(
        join(basename.replace('file://', ''), 'package.json'), 'utf8'
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
