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
 */
class AwsDurableExecutionSdkJsCheckpointPlugin extends Plugin {
  static id = 'aws-durable-execution-sdk-js'

  constructor (...args) {
    super(...args)

    this.addSub(
      'tracing:orchestrion:@aws/durable-execution-sdk-js:CheckpointManager_checkpoint:start',
      (ctx) => this._onCheckpointStart(ctx?.arguments)
    )
  }

  /**
   * @param {ArrayLike<unknown>} args - the call arguments to CheckpointManager.checkpoint
   */
  _onCheckpointStart (args) {
    const data = args?.[1]
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

    // The step's DurablePromise will not settle if the workflow suspends after this
    // retry checkpoint (terminationManager wins the race against waitForRetryTimer),
    // so the step plugin's asyncEnd never fires. Finish the span here to avoid a
    // dangling op span. If the retry resolves in-process and asyncEnd later finishes
    // the span again, dd-trace tolerates the double-finish.
    span.finish()
  }
}

module.exports = AwsDurableExecutionSdkJsCheckpointPlugin
