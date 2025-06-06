'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { extractErrorIntoSpanEvent } = require('./utils')

let tools

class GraphQLExecutePlugin extends TracingPlugin {
  static get id () { return 'graphql' }
  static get operation () { return 'execute' }
  static get type () { return 'graphql' }
  static get kind () { return 'server' }

  start ({ operation, args, docSource }) {
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
        'graphql.source': source
      }
    })

    addVariableTags(this.config, span, args.variableValues)
  }

  finish ({ res, args }) {
    const span = this.activeSpan
    this.config.hooks.execute(span, args, res)
    if (res?.errors) {
      for (const err of res.errors) {
        extractErrorIntoSpanEvent(this._tracerConfig, span, err)
      }
    }
    super.finish()
  }
}

// span-related

function addVariableTags (config, span, variableValues) {
  const tags = {}

  if (variableValues && config.variables) {
    const variables = config.variables(variableValues)
    if (variables) {
      for (const [param, variable] of Object.entries(variables)) {
        tags[`graphql.variables.${param}`] = variable
      }
    }
  }

  span.addTags(tags)
}

function getSignature (document, operationName, operationType, calculate) {
  if (calculate !== false && tools !== false) {
    try {
      try {
        tools = tools || require('./tools')
      } catch (error) {
        tools = false
        throw error
      }

      return tools.defaultEngineReportingSignature(document, operationName)
    } catch {
      // safety net
    }
  }

  return [operationType, operationName].filter(Boolean).join(' ')
}

module.exports = GraphQLExecutePlugin
