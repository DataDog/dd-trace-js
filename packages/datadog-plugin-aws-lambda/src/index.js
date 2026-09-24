'use strict'

const dc = require('dc-polyfill')

const { ERROR_MESSAGE, ERROR_TYPE } = require('../../dd-trace/src/constants')
const { getEnvironmentVariable } = require('../../dd-trace/src/config/helper')
const { ImpendingTimeout } = require('../../dd-trace/src/lambda/runtime/errors')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

const invocationStartChannel = dc.channel('datadog:aws-lambda:invocation:start')
const invocationEndChannel = dc.channel('datadog:aws-lambda:invocation:end')

class AwsLambdaPlugin extends TracingPlugin {
  /**
   * Starts the invocation span, timeout guard, and invocation boundary channels.
   *
   * @param {object} context Invocation channel context.
   * @returns {object} Trace store bound to the customer handler.
   */
  bindStart (context) {
    const functionName = context.context?.functionName ||
      getEnvironmentVariable('AWS_LAMBDA_FUNCTION_NAME') || ''
    // TODO(migration PR 8): the extracted upstream context becomes the parent. Until the context
    // extractors land, pinning `childOf` keeps the span from adopting a stale active span left
    // behind by a previous invocation in the same warm container.
    const span = this.startSpan('aws.lambda', {
      childOf: null,
      kind: 'server',
      resource: functionName,
      service: resolveServiceName(functionName, this.config),
      type: 'serverless',
    }, context)

    context.lambdaSpan = span
    this._startTimeout(context)
    invocationStartChannel.publish(context)

    return context.currentStore
  }

  /**
   * Tags handler failures on the invocation span.
   *
   * @param {{ error?: unknown, lambdaSpan?: object }} context Invocation channel context.
   */
  error (context) {
    this.addError(context.error, context.lambdaSpan)
  }

  /**
   * Publishes the completed invocation and finishes its span.
   *
   * @param {object} context Invocation channel context.
   */
  asyncStart (context) {
    invocationEndChannel.publish(context)
    this._finishSpan(context)
  }

  /**
   * Clears invocation resources after the result has propagated through the bound trace store.
   *
   * @param {object} context Invocation channel context.
   */
  asyncEnd (context) {
    if (context.lambdaTimeout) clearTimeout(context.lambdaTimeout)
  }

  /**
   * Arms the impending-timeout guard for an invocation with a Lambda context.
   *
   * @param {object} context Invocation channel context.
   */
  _startTimeout (context) {
    if (typeof context.context?.getRemainingTimeInMillis !== 'function') return

    const remainingTime = context.context.getRemainingTimeInMillis()
    const flushDeadline = this.config.apmFlushDeadlineMs
    if (!Number.isFinite(flushDeadline)) return

    context.lambdaTimeout = setTimeout(() => {
      const error = new ImpendingTimeout('Datadog detected an impending timeout')
      context.lambdaSpan?.addTags({
        [ERROR_MESSAGE]: error.message,
        [ERROR_TYPE]: error.name,
      })
      this.tracer._processor?.killAll()
      this._finishSpan(context)
    }, Math.max(0, remainingTime - flushDeadline))
    // Not unref'd: the whole point of the guard is to fire while the handler is still pending, and
    // an unref'd timer is skipped when it is the only thing keeping the loop alive.
  }

  /**
   * Finishes the invocation span at most once.
   *
   * Both the impending-timeout guard and the normal completion path reach this. A span that
   * finishes twice reports a second, wrong duration to the agent.
   *
   * @param {object} context Invocation channel context.
   */
  _finishSpan (context) {
    if (context.lambdaSpanFinished) return
    context.lambdaSpanFinished = true
    context.lambdaSpan?.finish()
  }
}

/**
 * Resolves the `aws.lambda` span service exactly as datadog-lambda-js does.
 *
 * Ported from `datadog-lambda-js/src/trace/listener.ts:386-397`. The service-naming schema's
 * `identityService` would hand back dd-trace's `Config.service`, which inside a Lambda is
 * `normalizeService(AWS_LAMBDA_FUNCTION_NAME)` — lowercased. `DD_SERVICE` is read raw and trimmed
 * for the same reason. Customers key dashboards and monitors off this value.
 *
 * @param {string} functionName Lambda function name.
 * @param {{ serviceRepresentationEnabled?: boolean }} config Plugin configuration.
 */
function resolveServiceName (functionName, config) {
  const envService = getEnvironmentVariable('DD_SERVICE')
  if (envService && envService.trim().length > 0) return envService.trim()

  if (config.serviceRepresentationEnabled === false) return 'aws.lambda'

  return functionName || 'aws.lambda'
}

AwsLambdaPlugin.id = 'aws-lambda'
AwsLambdaPlugin.kind = 'server'
AwsLambdaPlugin.operation = 'invoke'
AwsLambdaPlugin.prefix = 'tracing:datadog:aws-lambda:invoke'
AwsLambdaPlugin.type = 'serverless'

module.exports = AwsLambdaPlugin
