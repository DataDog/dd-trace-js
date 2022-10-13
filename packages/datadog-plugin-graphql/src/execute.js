'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

let tools

class GraphQLExecutePlugin extends TracingPlugin {
  static get name () { return 'graphql' }
  static get operation () { return 'execute' }

  start ({ operation, args, docSource }) {
    const type = operation && operation.operation
    const name = operation && operation.name && operation.name.value
    const document = args.document
    const source = this.config.source && document && docSource

    const span = this.startSpan('graphql.execute', {
      service: this.config.service,
      resource: getSignature(document, name, type, this.config.signature),
      kind: 'server',
      type: 'graphql',
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
    span.finish()
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
