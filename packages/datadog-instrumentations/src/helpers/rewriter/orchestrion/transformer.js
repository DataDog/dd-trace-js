'use strict'

/* eslint-disable camelcase */

const { generate, parse, traverse } = require('./compiler')
const transforms = require('./transforms')

let SourceMapConsumer
let SourceMapGenerator

class Transformer {
  #module_name = null
  #file_path = null
  #configs = []
  #dc_module = null

  // TODO: module_name false for user module
  constructor (module_name, _version, file_path, configs, dc_module) {
    this.#module_name = module_name
    this.#file_path = file_path
    this.#configs = configs
    this.#dc_module = dc_module
  }

  free () {
    // Freeing is not needed for a JavaScript implementation.
  }

  transform (code, module_type, sourcemap) {
    if (!code) return { code }

    const sourceType = module_type === 'esm' ? 'module' : 'script'

    let ast

    for (const config of this.#configs) {
      const { astQuery, functionQuery = {} } = config

      ast ??= parse(code.toString(), { range: true, sourceType })

      const query = astQuery || this.#fromFunctionQuery(functionQuery)
      const state = { ...config, dcModule: this.#dc_module, sourceType, functionQuery }

      state.operator = this.#getOperator(state)

      traverse(ast, query, (...args) => this.#visit(state, ...args))
    }

    if (ast) {
      SourceMapConsumer ??= require('../../../../../../vendor/dist/@datadog/source-map').SourceMapConsumer
      SourceMapGenerator ??= require('../../../../../../vendor/dist/@datadog/source-map').SourceMapGenerator

      const file = `${this.#module_name}/${this.#file_path}`
      const sourceMapInput = sourcemap ? new SourceMapConsumer(sourcemap) : { file }
      const sourceMap = new SourceMapGenerator(sourceMapInput)
      const code = generate(ast, { sourceMap })
      const map = sourceMap.toString()

      return { code, map }
    }

    return { code }
  }

  #visit (state, ...args) {
    const transform = transforms[state.operator]
    const { index } = state.functionQuery

    if (index !== undefined) {
      state.functionIndex = ++state.functionIndex || 0

      if (index !== state.functionIndex) return
    }

    transform(state, ...args)
  }

  #getOperator ({ functionQuery: { kind } }) {
    switch (kind) {
      case 'Async': return 'tracePromise'
      case 'AsyncIterator': return 'traceAsyncIterator'
      case 'Callback': return 'traceCallback'
      case 'Iterator': return 'traceIterator'
      case 'Sync': return 'traceSync'
    }
  }

  #fromFunctionQuery (functionQuery) {
    const { functionName, expressionName, className } = functionQuery
    const method = functionQuery.methodName || functionQuery.privateMethodName
    const type = functionQuery.privateMethodName ? 'PrivateIdentifier' : 'Identifier'
    const queries = []

    if (className) {
      queries.push(
        `[id.name="${className}"]`,
        `[id.name="${className}"] > ClassExpression`,
        `[id.name="${className}"] > ClassBody > [key.name="${method}"][key.type=${type}] > [async]`,
        `[id.name="${className}"] > ClassExpression > ClassBody > [key.name="${method}"][key.type=${type}] > [async]`
      )
    } else if (method) {
      queries.push(
        `ClassBody > [key.name="${method}"][key.type=${type}] > [async]`,
        `Property[key.name="${method}"][key.type=${type}] > [async]`
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
}

module.exports = { Transformer }
