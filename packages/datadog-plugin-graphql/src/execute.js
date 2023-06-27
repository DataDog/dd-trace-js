'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

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
    super.finish()
  }
}

// span-related

function addVariableTags (config, span, variableValues) {
  const tags = {}

  if (variableValues && config.variables) {
    const variables = config.variables(variableValues)
    for (const param in variables) {
      tags[`graphql.variables.${param}`] = variables[param]
    }
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
    } catch (e) {
      // safety net
    }
  }

  return [operationType, operationName].filter(val => val).join(' ')
}

module.exports = GraphQLExecutePlugin
