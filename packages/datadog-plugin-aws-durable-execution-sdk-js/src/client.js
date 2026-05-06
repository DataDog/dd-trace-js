'use strict'

const ClientPlugin = require('../../dd-trace/src/plugins/client')
const { isReplayedOp } = require('./util')

class AwsDurableExecutionSdkJsClientPlugin extends ClientPlugin {
  static id = 'aws-durable-execution-sdk-js'
  static type = 'serverless'
  static prefix = 'tracing:orchestrion:@aws/durable-execution-sdk-js:DurableContextImpl_invoke'

  // invoke has two overloads: invoke(name, funcId, ...) and invoke(funcId, ...).
  // They're distinguished by whether args[1] is a string (named form) or not.
  bindStart (ctx) {
    const args = ctx.arguments || []
    const hasName = typeof args[0] === 'string' && typeof args[1] === 'string'
    const operationName = hasName ? args[0] : undefined
    const functionName = hasName ? args[1] : (typeof args[0] === 'string' ? args[0] : undefined)

    const meta = {
      'aws.durable.replayed': String(isReplayedOp(ctx.self)),
    }
    if (functionName) {
      meta['aws.durable.invoke.function_name'] = functionName
    }

    this.startSpan('aws.durable.invoke', {
      resource: operationName,
      kind: this.constructor.kind,
      meta,
    }, ctx)
    this.injectTraceContextIntoInvokePayload(ctx)

    return ctx.currentStore
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
    super.finish(ctx)
  }

  error (ctxOrError) {
    super.error(ctxOrError)
    super.finish(ctxOrError)
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
