'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')

/**
 * Hooks `CheckpointManager.prototype.checkpoint` to capture the user-thrown
 * exception that triggers a retry-driven suspension, and attach it to the
 * step span as its error.
 *
 * The SDK's `createStepHandler` catches the user error in its retry path and
 * persists it via `checkpoint(stepId, { Action: 'RETRY', Error: errorObject })`
 * before awaiting `waitForRetryTimer`. After the timer await, the workflow may
 * suspend (terminationManager resolves first), so the step's DurablePromise
 * never settles — without this hook, the step span would carry no error.
 *
 * The seam is `checkpoint(...)` itself: at call time the active span (set by
 * the step plugin's bindStart) is the step we want to annotate.
 *
 * The span is finished on `:asyncEnd` rather than `:start` so that the AWS SDK
 * call made inside `checkpoint(...)` is fully contained within the step span;
 * finishing on `:start` would close the step span before its child
 * `aws.request` (`checkpointDurableExecution`) span has even begun. asyncEnd
 * still fires before the SDK's subsequent `await waitForRetryTimer`, so it
 * runs ahead of the suspension race the original eager-finish was guarding.
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

    const err = data.Error
    const stackRaw = err.StackTrace ?? err.stackTrace
    const stack = Array.isArray(stackRaw) ? stackRaw.join('\n') : (typeof stackRaw === 'string' ? stackRaw : undefined)
    const message = err.ErrorMessage ?? err.errorMessage
    const type = err.ErrorType ?? err.errorType

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
