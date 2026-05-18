'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class AwsDurableExecutionPlugin extends TracingPlugin {
  static id = 'aws-durable-execution'
  static operation = 'operation'
  static type = 'serverless'

  bindStart (ctx) {
    const operationType = ctx.operationType || 'unknown'
    const operationName = ctx.operationName
    const resource = operationName || operationType

    const span = this.startSpan(`aws.durable-execution.${operationType}`, {
      service: this.serviceName(),
      resource,
      type: 'serverless',
      meta: {
        'durable.operation_type': operationType,
        'durable.operation_name': operationName,
        'durable.execution_arn': ctx.executionArn,
        'aws.request_id': ctx.requestId,
        'aws.lambda.function_name': ctx.functionName
      }
    }, ctx)

    ctx.span = span
    return ctx.currentStore
  }

  error (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const error = ctx.error
    if (error instanceof Error) {
      span.setTag('error', error)
    }
  }

  finish (ctx) {
    ctx.currentStore?.span?.finish()
  }
}

module.exports = AwsDurableExecutionPlugin
