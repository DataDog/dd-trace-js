'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { storage } = require('../../datadog-core')

let tools

const OPERATION_DEFINITION = 'OperationDefinition'
const FRAGMENT_DEFINITION = 'FragmentDefinition'

class ApolloGatewayRequestPlugin extends TracingPlugin {
  static get id () { return 'apollo-gateway' }
  static get operation () { return 'request' }
  static get type () { return 'apollo-gateway' }
  static get kind () { return 'server' }
  static get prefix () {
    return 'tracing:apm:apollo-gateway:request'
  }

  bindStart (ctx) {
    const store = storage.getStore()
    const childOf = store ? store.span : null
    const spanData = {
      childOf,
      service: this.config.service || this.serviceName(),
      type: this.constructor.type,
      kind: this.constructor.kind,
      meta: {}
    }

    const { requestContext, gateway } = ctx

    if (requestContext.operationName) {
      spanData.meta['graphql.operation.name'] = requestContext.operationName
    }
    if (gateway.config?.telemetry.includeDocument !== false && requestContext.source) {
      spanData.meta['graphql.source'] = requestContext.source
    }

    const operationContext =
    buildOperationContext(gateway.schema, requestContext.document, requestContext.request.operationName)

    if (operationContext?.operation?.operation) {
      const document = requestContext.document
      const type = operationContext.operation.operation
      const name = operationContext.operation.name && operationContext.operation.name.value

      spanData['resource'] = getSignature(document, name, type, this.config.signature)
      spanData.meta['graphql.operation.type'] = operationContext.operation.operation
    }
    const span = this.startSpan(this.operationName(), spanData, false)

    ctx.parentStore = store
    ctx.currentStore = { ...store, span }
    return ctx.currentStore
  }

  asyncStart (ctx) {
    const errors = ctx?.result?.errors
    if (errors instanceof Array &&
      errors[errors.length - 1] && errors[errors.length - 1].stack && errors[errors.length - 1].message) {
      ctx.currentStore.span.setTag('error', errors[errors.length - 1])
    }
    ctx.currentStore.span.finish()
    return ctx.parentStore
  }

  error (ctx) {
    ctx.currentStore.span.setTag('error', ctx.error)
  }
}

function buildOperationContext (schema, operationDocument, operationName) {
  let operation
  let operationCount = 0
  const fragments = Object.create(null)
  operationDocument.definitions.forEach(definition => {
    switch (definition.kind) {
      case OPERATION_DEFINITION:
        operationCount++
        if (!operationName && operationCount > 1) {
          return
        }
        if (
          !operationName ||
          (definition.name && definition.name.value === operationName)
        ) {
          operation = definition
        }
        break
      case FRAGMENT_DEFINITION:
        fragments[definition.name.value] = definition
        break
    }
  })

  return {
    schema,
    operation,
    fragments
  }
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

module.exports = ApolloGatewayRequestPlugin
