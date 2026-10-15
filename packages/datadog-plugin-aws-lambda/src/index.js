'use strict'

const dc = require('dc-polyfill')

const { getEnvironmentVariable } = require('../../dd-trace/src/config/helper')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

const invocationStartChannel = dc.channel('datadog:aws-lambda:invocation:start')
const invocationEndChannel = dc.channel('datadog:aws-lambda:invocation:end')

class AwsLambdaPlugin extends TracingPlugin {
  /**
   * Starts the invocation span and publishes the invocation start boundary.
   *
   * Impending-timeout monitoring is deliberately not here: it belongs to
   * `packages/dd-trace/src/lambda/handler.js`, which decorates whatever span is active rather than
   * one it owns. That is what lets it work while the pre-migration shim still owns the span.
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
    // Span.finish() is idempotent, so a span the impending-timeout monitor already finished when
    // it fired is left untouched here.
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
