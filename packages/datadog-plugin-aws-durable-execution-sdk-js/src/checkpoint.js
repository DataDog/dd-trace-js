'use strict'

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

// On retries the SDK suspends execution without firing error/asyncEnd; finish the span here.
class AwsDurableExecutionSdkJsCheckpointPlugin extends TracingPlugin {
  static id = 'aws-durable-execution-sdk-js'
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:CheckpointManager_checkpoint'

  start (ctx) {
    const data = ctx?.arguments?.[1]
    if (data?.Action !== 'RETRY' || !data.Error) return

    const span = this.activeSpan
    if (!span || span.context().getTag('error')) return

    const { ErrorMessage, ErrorType, StackTrace } = data.Error
    span.setTag('error', 1)
    if (ErrorMessage) span.setTag('error.message', ErrorMessage)
    if (ErrorType) span.setTag('error.type', ErrorType)
    if (Array.isArray(StackTrace)) span.setTag('error.stack', StackTrace.join('\n'))

    ctx.retryStepSpan = span
  }

  asyncEnd (ctx) {
    ctx.retryStepSpan?.finish()
  }
}

module.exports = AwsDurableExecutionSdkJsCheckpointPlugin
