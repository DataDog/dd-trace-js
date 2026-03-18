'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

let tools

class GraphqlExecutePlugin extends TracingPlugin {
  static id = 'graphql'
  static prefix = 'tracing:orchestrion:graphql:graphql_execute'
  static kind = 'server'
  static type = 'graphql'

  bindStart (ctx) {
    const args = getExecuteArgs(ctx.arguments)
    const document = args.document
    const operationName = args.operationName
    const variableValues = args.variableValues
    const operation = getOperation(document, operationName)
    const type = operation?.operation
    const name = operation?.name?.value || operationName
    const source = this.config.source && document && getDocSource(document)

    const span = this.startSpan('graphql.execute', {
      service: this.config.service,
      resource: getSignature(document, name, type, this.config.signature),
      kind: 'server',
      type: 'graphql',
      meta: {
        component: 'graphql',
        'graphql.operation.type': type,
        'graphql.operation.name': name,
        'graphql.source': source,
      },
    }, ctx)

    addVariableTags(this.config, span, variableValues)

    return ctx.currentStore
  }

  end (ctx) {
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    const span = ctx.currentStore?.span

    if (ctx.error) {
      span?.setTag('error', ctx.error)
      span?.finish()
      return
    }

    const result = ctx.result

    // graphql v0.10.x execute() returns a Promise; later versions return synchronously.
    if (result && typeof result.then === 'function') {
      result.then((resolved) => {
        setExecuteErrorTags(span, resolved)
        span?.finish()
      }, (error) => {
        span?.setTag('error', error)
        span?.finish()
      })
      return
    }

    setExecuteErrorTags(span, result)
    span?.finish()
  }
}

/**
 * Sets error tags on a span from a GraphQL ExecutionResult.
 * execute() returns errors in result.errors rather than throwing.
 * Tags are set explicitly to handle old graphql versions where GraphQLError
 * may not be recognized as a proper Error instance by setTag.
 * @param {object} span - The span to set tags on
 * @param {object} result - The GraphQL execution result
 */
function setExecuteErrorTags (span, result) {
  if (!span || !result?.errors?.length) return
  const err = result.errors[0]
  span.setTag('error', 1)
  span.setTag('error.type', err.constructor?.name || 'GraphQLError')
  span.setTag('error.message', err.message)
  span.setTag('error.stack', err.stack)
}

/**
 * Normalizes execute() arguments across graphql versions.
 * graphql v16+ uses a single args object; older versions use positional args.
 * @param {Array} args - The arguments passed to execute()
 * @returns {{ schema: object, document: object, variableValues: object, operationName: string }}
 */
function getExecuteArgs (args) {
  if (!args) return {}
  const first = args[0]
  if (first?.kind === 'Document' || args.length > 1) {
    return {
      schema: first,
      document: args[1],
      variableValues: args[4],
      operationName: args[5],
    }
  }
  return first || {}
}

/**
 * Finds the operation definition matching the given operation name.
 * @param {object} document - The parsed GraphQL document AST
 * @param {string} [operationName] - The name of the operation to find
 * @returns {object|undefined} The matching OperationDefinition node
 */
function getOperation (document, operationName) {
  if (!document?.definitions) return undefined
  for (const def of document.definitions) {
    if (def.kind !== 'OperationDefinition') continue
    if (!operationName || def.name?.value === operationName) return def
  }
  return undefined
}

/**
 * Gets the source text from a GraphQL document AST.
 * @param {object} document - The parsed GraphQL document AST
 * @returns {string|undefined} The source text
 */
function getDocSource (document) {
  return document?.loc?.source?.body
}

/**
 * Calculates the resource name signature for a GraphQL operation.
 * Uses apollo-style signature calculation when available, falling back to
 * operation type + name.
 * @param {object} document - The parsed GraphQL document AST
 * @param {string} operationName - The operation name
 * @param {string} operationType - The operation type (query/mutation/subscription)
 * @param {boolean|Function} calculate - Whether to calculate the signature
 * @returns {string} The resource name
 */
function getSignature (document, operationName, operationType, calculate) {
  if (calculate !== false && tools !== false) {
    try {
      tools = tools || require('./tools')
      return tools.defaultEngineReportingSignature(document, operationName)
    } catch {
      tools = false
    }
  }
  return [operationType, operationName].filter(Boolean).join(' ')
}

/**
 * Adds variable tags to the span based on configuration.
 * @param {object} config - The plugin configuration
 * @param {object} span - The span to add tags to
 * @param {object} variableValues - The GraphQL variable values
 */
function addVariableTags (config, span, variableValues) {
  if (!variableValues || !config.variables) return
  const variables = config.variables(variableValues)
  const tags = {}
  for (const param in variables) {
    tags[`graphql.variables.${param}`] = variables[param]
  }
  span.addTags(tags)
}

module.exports = GraphqlExecutePlugin
