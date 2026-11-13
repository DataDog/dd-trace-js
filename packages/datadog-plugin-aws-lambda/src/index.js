'use strict'

const dc = require('dc-polyfill')

const { getEnvironmentVariable } = require('../../dd-trace/src/config/helper')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const log = require('../../dd-trace/src/log')
const TraceContextExtractor = require('./context/extractor')

const invocationStartChannel = dc.channel('datadog:aws-lambda:invocation:start')
const invocationEndChannel = dc.channel('datadog:aws-lambda:invocation:end')

class AwsLambdaPlugin extends TracingPlugin {
  /** @param {...object} args Plugin constructor arguments. */
  constructor (...args) {
    super(...args)
    this.addSub('datadog:aws-lambda:invocation:prepare', this.prepare)
  }

  /**
   * Subscribers publish synchronously; the instrumentation awaits this explicit preparation promise
   * before publishing span start. No invocation span is created during extraction.
   * @param {object} context Invocation channel context.
   */
  prepare (context) {
    const config = {
      traceExtractor: context.config?.traceExtractor ?? this.config.traceExtractor,
      decodeAuthorizerContext: context.config?.decodeAuthorizerContext ?? this.config.decodeAuthorizerContext,
    }
    const extractor = new TraceContextExtractor(this.tracer, config)
    const apply = extracted => {
      const merge = context.config?.mergeXrayTraces ??
        context.config?.mergeDatadogXrayTraces ?? this.config.mergeXrayTraces
      if (extracted.source === 'event' || merge) {
        context.parent = extracted.spanContext
        context.parentSource = extracted.source
      }
    }
    try {
      const extracted = this.tracer.scope().activate(null, () => extractor.extract(context.event, context.context))
      if (config.traceExtractor) {
        context.preparation = extracted.then(apply).catch(error => {
          log.error('Unable to prepare Lambda trace context: %s', error)
        })
      } else {
        apply(extracted)
      }
    } catch (error) {
      log.error('Unable to prepare Lambda trace context: %s', error)
    }
  }

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
      getEnvironmentVariable('AWS_LAMBDA_FUNCTION_NAME')
    const span = this.startSpan('aws.lambda', {
      childOf: context.parent || null,
      meta: context.parent ? { '_dd.parent_source': context.parentSource } : undefined,
      kind: 'server',
      resource: functionName,
      service: resolveServiceName(functionName, this.config, context.config),
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
   * Restores invocation scope when completion arrives through an externally invoked callback.
   *
   * @param {object} context Invocation channel context.
   * @returns {object} Invocation trace store.
   */
  bindAsyncStart (context) {
    return context.currentStore
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
 * Honors per-handler and plugin service overrides before applying datadog-lambda-js service defaults.
 *
 * Fallbacks ported from `datadog-lambda-js/src/trace/listener.ts:386-397`. The service-naming schema's
 * `identityService` would hand back dd-trace's `Config.service`, which inside a Lambda is
 * `normalizeService(AWS_LAMBDA_FUNCTION_NAME)` — lowercased. `DD_SERVICE` is read raw and trimmed
 * for the same reason. Customers key dashboards and monitors off this value.
 *
 * @param {string} functionName Lambda function name.
 * @param {{ service?: string, serviceRepresentationEnabled?: boolean }} pluginConfig Plugin-specific configuration.
 * @param {{ service?: string, serviceRepresentationEnabled?: boolean }} [handlerConfig] Per-handler overrides.
 */
function resolveServiceName (functionName, pluginConfig, handlerConfig) {
  const service = handlerConfig?.service ?? pluginConfig.service
  if (service) return service

  const envService = getEnvironmentVariable('DD_SERVICE')
  if (envService && envService.trim().length > 0) return envService.trim()

  const serviceRepresentationEnabled = handlerConfig?.serviceRepresentationEnabled ??
    pluginConfig.serviceRepresentationEnabled
  if (serviceRepresentationEnabled === false) return 'aws.lambda'

  return functionName || 'aws.lambda'
}

AwsLambdaPlugin.id = 'aws-lambda'
AwsLambdaPlugin.kind = 'server'
AwsLambdaPlugin.operation = 'invoke'
AwsLambdaPlugin.prefix = 'tracing:datadog:aws-lambda:invoke'
AwsLambdaPlugin.type = 'serverless'

module.exports = AwsLambdaPlugin
