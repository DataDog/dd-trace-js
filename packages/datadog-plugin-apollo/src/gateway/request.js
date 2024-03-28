'use strict'

const { storage } = require('../../../datadog-core')
const ApolloBasePlugin = require('../../../dd-trace/src/plugins/apollo')

let tools

const OPERATION_DEFINITION = 'OperationDefinition'
const FRAGMENT_DEFINITION = 'FragmentDefinition'

class ApolloGatewayRequestPlugin extends ApolloBasePlugin {
  static get operation () { return 'request' }
  static get prefix () {
    return 'tracing:apm:apollo:gateway:request'
  }

  bindStart (ctx) {
    const store = storage.getStore()
    const childOf = store ? store.span : null
    const spanData = {
      childOf,
      service: this.serviceName(
        { id: `${this.constructor.id}.${this.constructor.operation}`, pluginConfig: this.config }),
      type: this.constructor.type,
      kind: this.constructor.kind,
      meta: {}
    }

    const { requestContext, gateway } = ctx

    if (requestContext?.operationName) {
      spanData.meta['graphql.operation.name'] = requestContext.operationName
    }
    if ((this.config.source || gateway?.config?.telemetry?.includeDocument) && requestContext?.source) {
      spanData.meta['graphql.source'] = requestContext.source
    }

    const operationContext =
    buildOperationContext(gateway.schema, requestContext.document, requestContext.request.operationName)

    if (operationContext?.operation?.operation) {
      const document = requestContext?.document
      const type = operationContext?.operation?.operation
      const name = operationContext?.operation?.name && operationContext?.operation?.name?.value

      spanData.resource = getSignature(document, name, type, this?.config?.signature)
      spanData.meta['graphql.operation.type'] = type
    }
    const span = this.startSpan(this.operationName({ id: `${this.constructor.id}.${this.constructor.operation}` }),
      spanData, false)

    ctx.parentStore = store
    ctx.currentStore = { ...store, span }
    return ctx.currentStore
  }

  asyncStart (ctx) {
    const errors = ctx?.result?.errors
    // apollo gateway catches certain errors and returns them in the result object
    // we want to capture these errors as spans
    if (errors instanceof Array &&
      errors[errors.length - 1] && errors[errors.length - 1].stack && errors[errors.length - 1].message) {
      ctx.currentStore.span.setTag('error', errors[errors.length - 1])
    }
    ctx.currentStore.span.finish()
    return ctx.parentStore
  }
}

function buildOperationContext (schema, operationDocument, operationName) {
  let operation
  let operationCount = 0
  const fragments = Object.create(null)
  try {
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
  } catch (e) {
    // safety net
  }

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
        tools = tools || require('../../../datadog-plugin-graphql/src/tools')
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
