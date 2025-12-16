'use strict'

/*
This rewriter is basically a JavaScript version of Orchestrion-JS. The goal is
not to replace Orchestrion-JS, but rather to make it easier and faster to write
new integrations in the short-term, especially as many changes to the rewriter
will be needed as all the patterns we need have not been identified yet. This
will avoid the back and forth of having to make Rust changes to an external
library for every integration change or addition that requires something new.

In the meantime, we'll work concurrently on a change to Orchestrion-JS that
adds an "arbitrary transform" or "plugin" system that can be used from
JavaScript, in order to enable quick iteration while still using Orchestrion-JS.
Once that's done we'll use that, so that we can remove this JS approach and
return to using Orchestrion-JS.

The long term goal is to backport any additional features we add to the JS
rewriter (or using the plugin system in Orchestrion-JS once we're using that)
to Orchestrion-JS  once we're confident that the implementation is fairly
complete and has all features we need.

Here is a list of the additions and changes in this rewriter compared to
Orchestrion-JS that will need to be backported:

(NOTE: Please keep this list up-to-date whenever new features are added)

- Supports an `astQuery` field to filter AST nodes with an esquery query. This
  is mostly meant to be used when experimenting or if what needs to be queried
  is not a function. We'll see over time if something like this is needed to be
  backported or if it can be replaced by simpler queries.
- Supports replacing methods of child class instances in the base constructor.
*/

const { readFileSync } = require('fs')
const { join } = require('path')
const semifies = require('../../../../../vendor/dist/semifies')
const transforms = require('./transforms')
const { generate, parse, traverse } = require('./compiler')
const log = require('../../../../dd-trace/src/log')
const instrumentations = require('./instrumentations')
const { getEnvironmentVariable } = require('../../../../dd-trace/src/config-helper')

const NODE_OPTIONS = getEnvironmentVariable('NODE_OPTIONS')

const supported = {}
const disabled = new Set()

// TODO: Source maps without `--enable-source-maps`.
const enableSourceMaps = NODE_OPTIONS?.includes('--enable-source-maps') ||
  process.execArgv?.some(arg => arg.includes('--enable-source-maps'))

let SourceMapGenerator

function rewrite (content, filename, format) {
  if (!content) return content

  try {
    let ast

    filename = filename.replace('file://', '')

    for (const inst of instrumentations) {
      const { astQuery, functionQuery = {}, module: { name, versionRange, filePath } } = inst
      const { kind } = functionQuery
      const operator = kind === 'Async' ? 'tracePromise' : kind === 'Callback' ? 'traceCallback' : 'traceSync'
      const transform = transforms[operator]

      if (disabled.has(name)) continue
      if (!filename.endsWith(`${name}/${filePath}`)) continue
      if (!transform) continue
      if (!satisfies(filename, filePath, versionRange)) continue

      ast ??= parse(content.toString(), { loc: true, ranges: true, module: format === 'module' })

      const query = astQuery || fromFunctionQuery(functionQuery)
      const state = { ...inst, format, functionQuery, operator }

      traverse(ast, query, (...args) => transform(state, ...args))
    }

    if (ast) {
      if (!enableSourceMaps) return generate(ast)

      // TODO: Can we use the same version of `source-map` that DI uses?
      SourceMapGenerator ??= require('../../../../../vendor/dist/@datadog/source-map').SourceMapGenerator

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
