'use strict'

const dc = require('dc-polyfill')

const { getEnvironmentVariable } = require('../../dd-trace/src/config/helper')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const log = require('../../dd-trace/src/log')
const TraceContextExtractor = require('./context/extractor')
const { injectAuthorizerSpan } = require('./context/http')
const SpanInferrer = require('./span-inferrer')

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
    // Match the shim's stale-span cleanup before detaching the extraction scope.
    try {
      const activeSpan = this.tracer.scope().active()
      if (activeSpan && typeof activeSpan.finish === 'function') activeSpan.finish()
    } catch (error) {
      log.debug('Unable to finish stale Lambda span: %s', error)
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
    if (context.config?.createInferredSpan ?? this.config.createInferredSpan) {
      const inferrer = new SpanInferrer(this.tracer, {
        service: getEnvironmentVariable('DD_SERVICE'),
        serviceMapping: this._tracerConfig.tracing.DD_SERVICE_MAPPING,
        serviceRepresentationEnabled: context.config?.serviceRepresentationEnabled ??
          this.config.serviceRepresentationEnabled,
        removeIntegrationServiceNamesEnabled:
          this._tracerConfig.tracing.DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED,
      })
      try {
        // The source listener gates inferred authorizer decoding with encodeAuthorizerContext.
        context.inferredSpan = this.tracer.scope().activate(null, () =>
          inferrer.createInferredSpan(context.event, context.context, context.parent,
            context.config?.encodeAuthorizerContext ?? this.config.encodeAuthorizerContext))
      } catch (error) {
        log.debug('Unable to create Lambda inferred span: %s', error)
      }
    }
    const span = this.startSpan('aws.lambda', {
      childOf: context.inferredSpan?.span || context.parent || null,
      meta: context.parent && (context.parentSource === 'event' || context.parentSource === 'xray')
        ? { '_dd.parent_source': context.parentSource }
        : undefined,
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
    // The shim's tracer.wrap finishes the invocation before onCompleteInvocation finishes its parent.
    context.lambdaSpan?.finish()
    const inferred = context.inferredSpan
    let finishTime
    try {
      if (inferred) {
        if (context.error && !inferred.isAsync) inferred.span.setTag('error', context.error)
        finishTime = inferred.isAsync ? context.lambdaSpan._startTime : Date.now()
        inferred.span.finish(finishTime)
      }
    } catch (error) {
      log.debug('Unable to finish Lambda inferred span: %s', error)
    }
    if ((context.config?.encodeAuthorizerContext ?? this.config.encodeAuthorizerContext) &&
        context.result?.principalId && context.result?.policyDocument) {
      try {
        const span = inferred?.span || context.lambdaSpan
        finishTime ??= span._startTime + span._duration
        injectAuthorizerSpan(this.tracer, context.result, span, context.event?.requestContext?.requestId, finishTime)
      } catch (error) {
        log.debug('Unable to inject Lambda authorizer context: %s', error)
      }
    }
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
