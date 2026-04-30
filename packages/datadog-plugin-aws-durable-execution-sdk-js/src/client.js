'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')

class AwsDurableExecutionSdkJsClientPlugin extends ClientPlugin {
  static id = 'aws-durable-execution-sdk-js'
  static type = 'serverless'
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_invoke'
  static peerServicePrecursors = ['functionname']

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    this.startSpan('aws.durable_execution.invoke', {
      service: process.env.DD_DURABLE_EXECUTION_SERVICE || 'aws.durable_execution',
      resource: meta.operationname || meta.functionname || 'aws.durable_execution.invoke',
      meta,
    }, ctx)

    this.injectTraceContextIntoInvokePayload(ctx)

    return ctx.currentStore
  }

  /**
   * Extracts tags from the invoke method arguments.
   * invoke has two overloads:
   *   invoke(name, funcId, input?, config?)  — args[1] is a string (funcId)
   *   invoke(funcId, input?, config?)        — args[1] is an object or undefined
   * @param {{ arguments?: ArrayLike<unknown> }} ctx
   * @returns {Record<string, string>}
   */
  getTags (ctx) {
    const args = ctx.arguments || []
    const hasName = typeof args[0] === 'string' && typeof args[1] === 'string'
    const operationname = hasName ? args[0] : undefined
    const functionname = hasName ? args[1] : (typeof args[0] === 'string' ? args[0] : undefined)

    const tags = {
      component: 'aws-durable-execution-sdk-js',
      'span.kind': 'client',
    }

    if (operationname) {
      tags.operationname = operationname
    }
    if (functionname) {
      tags.functionname = functionname
    }

    return tags
  }

  /**
   * Inject Datadog trace headers into invoke input payload under `_datadog`
   * when the input is a plain object.
   *
   * Durable invoke overloads:
   *   invoke(name, funcId, input?, config?)
   *   invoke(funcId, input?, config?)
   *
   * We only mutate the payload when there is a dictionary-like input object.
   * Primitive/array/empty input values are left unchanged.
   *
   * @param {{ arguments?: ArrayLike<unknown>, currentStore?: { span?: unknown } }} ctx
   */
  injectTraceContextIntoInvokePayload (ctx) {
    const args = ctx.arguments || []
    const inputArgIndex = getInvokeInputArgIndex(args)
    if (inputArgIndex === -1 || inputArgIndex >= args.length) return

    const input = args[inputArgIndex]
    if (!isPlainObject(input)) return

    const span = ctx.currentStore?.span
    if (!span || typeof this._tracer?.inject !== 'function') return

    const injectedHeaders = {}
    try {
      this._tracer.inject(span, 'http_headers', injectedHeaders)
    } catch {
      return
    }
    if (Object.keys(injectedHeaders).length === 0) return

    try {
      const existing = isPlainObject(input._datadog) ? input._datadog : {}
      input._datadog = { ...existing, ...injectedHeaders }
    } catch {
      // Best-effort: payload may be frozen/non-writable.
    }
  }

  asyncEnd (ctx) {
    this.finish(ctx)
  }

  end (ctx) {
    this.finish(ctx)
  }
  // tracingChannel fires both asyncEnd and end; Need to call finish in both cases to ensure the span is finished regardless of how the tracingChannel is configured.
  finish (ctx) {
    super.finish(ctx)
  }
}

function getInvokeInputArgIndex (args) {
  const hasName = typeof args[0] === 'string' && typeof args[1] === 'string'
  if (hasName) return 2
  if (typeof args[0] === 'string') return 1
  return -1
}

function isPlainObject (value) {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

module.exports = AwsDurableExecutionSdkJsClientPlugin
