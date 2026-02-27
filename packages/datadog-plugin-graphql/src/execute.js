'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { extractErrorIntoSpanEvent } = require('./utils')

let tools

class GraphQLExecutePlugin extends TracingPlugin {
  static id = 'graphql'
  static operation = 'execute'
  static type = 'graphql'
  static kind = 'server'

  bindStart (ctx) {
    const { operation, args, docSource } = ctx

    const type = operation && operation.operation
    const name = operation && operation.name && operation.name.value
    const document = args.document
    const source = this.config.source && document && docSource

    const span = this.startSpan(this.operationName(), {
      service: this.config.service || this.serviceName(),
      resource: getSignature(document, name, type, this.config.signature),
      kind: this.constructor.kind,
      type: this.constructor.type,
      meta: {
        'graphql.operation.type': type,
        'graphql.operation.name': name,
        'graphql.source': source,
      },
    }, ctx)

    ctx.filteredVariables = args.variableValues && this.config.variables(args.variableValues, { ...args, operation })

    addVariableTags(span, ctx.filteredVariables)

    return ctx.currentStore
  }

  finish (ctx) {
    const { result, args } = ctx
    const span = ctx?.currentStore?.span || this.activeSpan
    this.config.hooks.execute(span, args, result)
    if (result?.errors) {
      for (const err of result.errors) {
        extractErrorIntoSpanEvent(this._tracerConfig, span, err)
      }
    }
    super.finish(ctx)
  }
}

// span-related

function addVariableTags (span, variableValues) {
  if (!variableValues) return

  const tags = {}
  for (const param in variableValues) {
    tags[`graphql.variables.${param}`] = variableValues[param]
  }
  span.addTags(tags)
}

function getSignature (document, operationName, operationType, calculate) {
  if (calculate !== false && tools !== false) {
    try {
      try {
        tools = tools || require('./tools')
      } catch (e) {
        tools = false
        throw e
      }

      return tools.defaultEngineReportingSignature(document, operationName)
    } catch {
      // safety net
    }
  }

  return [operationType, operationName].filter(Boolean).join(' ')
}

module.exports = GraphQLExecutePlugin
