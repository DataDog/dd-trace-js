'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')

/**
 * On retries, execution is suspended and error/asyncEnd are not called.
 * Finish the span (possibly with error) from the checkpoint.
 */
class AwsDurableExecutionSdkJsCheckpointPlugin extends Plugin {
  static id = 'aws-durable-execution-sdk-js'

  constructor (...args) {
    super(...args)

    this.addSub(
      'tracing:orchestrion:@aws/durable-execution-sdk-js:CheckpointManager_checkpoint:start',
      (ctx) => this._onCheckpointStart(ctx)
    )
    this.addSub(
      'tracing:orchestrion:@aws/durable-execution-sdk-js:CheckpointManager_checkpoint:asyncEnd',
      (ctx) => this._onCheckpointAsyncEnd(ctx)
    )
  }

  _onCheckpointStart (ctx) {
    const data = ctx?.arguments?.[1]
    if (!data || data.Action !== 'RETRY' || !data.Error) return

    const span = storage('legacy').getStore()?.span
    if (!span) return
    if (span._spanContext?._tags?.error) return
    
    const { ErrorMessage: message, ErrorType: type, StackTrace } = data.Error
    const stack = Array.isArray(StackTrace) ? StackTrace.join('\n') : undefined

    span.setTag('error', 1)
    if (message) span.setTag('error.message', message)
    if (type) span.setTag('error.type', type)
    if (stack) span.setTag('error.stack', stack)

    ctx._ddRetryStepSpan = span
  }

  _onCheckpointAsyncEnd (ctx) {
    const span = ctx?._ddRetryStepSpan
    if (!span) return
    ctx._ddRetryStepSpan = undefined
    span.finish()
  }
}

module.exports = AwsDurableExecutionSdkJsCheckpointPlugin
