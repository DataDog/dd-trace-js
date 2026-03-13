'use strict'

const { COMPONENT } = require('../../dd-trace/src/constants')
const { ERROR_MESSAGE, ERROR_TYPE } = require('../../dd-trace/src/constants')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const log = require('../../dd-trace/src/log')
const { storage } = require('../../datadog-core')

const { parseEventSource, extractTriggerTags, extractHTTPStatusCodeTag } = require('./trigger')
const { createInferredSpan } = require('./span-inferrer')
const { extractTraceContext } = require('./trace-context-extractor')
const { patchConsole, unpatchConsole } = require('./console-patcher')
const { LambdaDogStatsD, isExtensionRunning } = require('./dogstatsd')
const { incrementInvocations, incrementErrors, incrementBatchItemFailures } = require('./enhanced-metrics')
const { didFunctionColdStart, setSandboxInit } = require('./cold-start')
const { traceColdStart } = require('./cold-start-tracer')
const { tagObject, isBatchItemFailure, batchItemFailureCount, HANDLER_STREAMING, STREAM_RESPONSE } = require('./handler-utils')
const { getSpanPointerAttributes } = require('./span-pointers')
const { ImpendingTimeout } = require('../../dd-trace/src/lambda/runtime/errors')

const initTime = Date.now()

class LambdaPlugin extends TracingPlugin {
  static id = 'lambda'
  static operation = 'invoke'
  static kind = 'server'
  static type = 'serverless'
  static prefix = 'tracing:datadog:lambda:invoke'

  constructor (...args) {
    super(...args)
    this._dogstatsd = null
    this._timeoutTimer = null
  }

  configure (config) {
    const lambdaConfig = Object.assign({
      enhancedMetrics: true,
      createInferredSpan: true,
      captureLambdaPayload: false,
      captureLambdaPayloadMaxDepth: 10,
      mergeXrayTraces: false,
      injectLogContext: true,
      encodeAuthorizerContext: true,
      decodeAuthorizerContext: true,
      coldStartTracing: true,
      minColdStartTraceDurationMs: 3,
      coldStartTraceSkipLib: '',
      addSpanPointers: true,
    }, config.lambda || {})

    return super.configure(Object.assign({}, config, { lambda: lambdaConfig }))
  }

  bindStart (ctx) {
    const { event, context } = ctx
    const config = this.config?.lambda || {}

    // Cold start detection
    setSandboxInit(initTime, Date.now())
    const coldStart = didFunctionColdStart()

    // Parse event source
    const eventSource = parseEventSource(event)
    ctx._eventSource = eventSource

    // Detect response streaming
    ctx._isResponseStream = ctx.isResponseStream || false

    // Extract trigger tags
    let triggerTags = {}
    if (context) {
      try {
        triggerTags = extractTriggerTags(event, context, eventSource)
      } catch (e) {
        log.debug('Failed to extract trigger tags')
      }
    }
    ctx._triggerTags = triggerTags

    // Extract trace context from event
    let parentSpanContext
    try {
      parentSpanContext = extractTraceContext(event, context, this.tracer, config)
    } catch (e) {
      log.debug('Failed to extract trace context from event')
    }

    // Create inferred span if enabled
    let inferredSpanResult
    if (config.createInferredSpan) {
      try {
        inferredSpanResult = createInferredSpan(
          event, context, parentSpanContext, this.tracer, config.decodeAuthorizerContext
        )
      } catch (e) {
        log.debug('Failed to create inferred span')
      }
    }
    ctx._inferredSpan = inferredSpanResult?.span
    ctx._inferredSpanIsAsync = inferredSpanResult?.isAsync

    // Determine the parent for the aws.lambda span
    const childOf = inferredSpanResult?.span || parentSpanContext || null

    // Create the aws.lambda span
    const functionArn = context?.invokedFunctionArn || process.env.AWS_LAMBDA_FUNCTION_NAME || ''
    const functionName = context?.functionName || process.env.AWS_LAMBDA_FUNCTION_NAME || ''
    const requestId = context?.awsRequestId

    const meta = Object.assign({}, triggerTags, {
      cold_start: coldStart.toString(),
      function_arn: functionArn,
      request_id: requestId,
      'resource.name': functionName,
      functionname: functionName,
      'span.type': 'serverless',
    })

    const span = this.startSpan('aws.lambda', {
      service: this.serviceName(),
      resource: functionName,
      type: 'serverless',
      kind: 'server',
      meta,
      childOf,
    }, ctx)

    ctx._lambdaSpan = span

    // Setup timeout detection
    if (context?.getRemainingTimeInMillis) {
      this._setupTimeout(context, span)
    }

    // Patch console for log injection
    if (config.injectLogContext) {
      const tracer = this.tracer
      patchConsole(function () {
        return tracer.scope().active()
      })
    }

    // Initialize DogStatsD and send invocation metric
    if (config.enhancedMetrics) {
      if (!this._dogstatsd && isExtensionRunning()) {
        this._dogstatsd = new LambdaDogStatsD()
      }
      if (this._dogstatsd) {
        incrementInvocations(this._dogstatsd, context)
      }
    }

    // Capture event payload
    if (config.captureLambdaPayload) {
      try {
        tagObject(span, 'function.request', event, 0, config.captureLambdaPayloadMaxDepth)
      } catch (e) {
        log.debug('Failed to tag event payload')
      }
    }

    return ctx.currentStore
  }

  asyncStart (ctx) {
    const { result, context } = ctx
    const config = this.config?.lambda || {}
    const span = ctx._lambdaSpan || ctx.currentStore?.span

    if (!span) return

    // Extract HTTP status code
    const statusCode = extractHTTPStatusCodeTag(ctx._triggerTags, result, ctx._isResponseStream)
    if (statusCode) {
      span.setTag('http.status_code', statusCode)
      if (ctx._inferredSpan) {
        ctx._inferredSpan.setTag('http.status_code', statusCode)
      }
    }

    // Capture response payload
    if (config.captureLambdaPayload && result !== undefined) {
      try {
        tagObject(span, 'function.response', result, 0, config.captureLambdaPayloadMaxDepth)
      } catch (e) {
        log.debug('Failed to tag response payload')
      }
    }

    // Enhanced metrics for errors
    if (config.enhancedMetrics && this._dogstatsd) {
      if (ctx.error) {
        incrementErrors(this._dogstatsd, context)
      }
      if (isBatchItemFailure(result)) {
        const count = batchItemFailureCount(result)
        incrementBatchItemFailures(this._dogstatsd, count, context)
      }
    }

    // Add span pointers
    if (config.addSpanPointers) {
      try {
        const pointers = getSpanPointerAttributes(ctx.event)
        for (const p of pointers) {
          span.addLink(p.pointer)
        }
      } catch (e) {
        log.debug('Failed to add span pointers')
      }
    }

    // Finish inferred span
    if (ctx._inferredSpan) {
      try {
        if (ctx._inferredSpanIsAsync) {
          // For async spans, finish at the same time as the lambda span
          // (will be finished when lambda span finishes)
        } else {
          ctx._inferredSpan.finish()
        }
      } catch (e) {
        log.debug('Failed to finish inferred span')
      }
    }

    // Finish the lambda span
    span.finish()
  }

  error (ctx) {
    this.addError(ctx.error)
  }

  asyncEnd (ctx) {
    // Clean up timeout timer
    if (this._timeoutTimer) {
      clearTimeout(this._timeoutTimer)
      this._timeoutTimer = null
    }

    // Unpatch console
    unpatchConsole()

    // Finish async inferred span
    if (ctx._inferredSpan && ctx._inferredSpanIsAsync) {
      try {
        ctx._inferredSpan.finish()
      } catch (e) {
        log.debug('Failed to finish async inferred span')
      }
    }

    // Flush DogStatsD
    if (this._dogstatsd) {
      this._dogstatsd.flush()
    }
  }

  _setupTimeout (lambdaContext, span) {
    const remainingTime = lambdaContext.getRemainingTimeInMillis()
    let flushDeadline = Number.parseInt(process.env.DD_APM_FLUSH_DEADLINE_MILLISECONDS) || 100
    if (flushDeadline < 0) flushDeadline = 100

    const self = this
    this._timeoutTimer = setTimeout(function () {
      const error = new ImpendingTimeout('Datadog detected an impending timeout')
      span.addTags({
        [ERROR_MESSAGE]: error.message,
        [ERROR_TYPE]: error.name,
      })

      // Kill unfinished spans and finish the root
      const tracer = self._tracer
      if (tracer?._processor) {
        tracer._processor.killAll()
      }
      span.finish()
    }, remainingTime - flushDeadline)

    if (this._timeoutTimer.unref) {
      this._timeoutTimer.unref()
    }
  }
}

module.exports = LambdaPlugin
