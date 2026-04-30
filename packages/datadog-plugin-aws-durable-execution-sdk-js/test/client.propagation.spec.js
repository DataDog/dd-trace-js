'use strict'

const assert = require('node:assert/strict')
const AwsDurableExecutionSdkJsClientPlugin = require('../src/client')

describe('client invoke propagation', () => {
  function createPlugin (headers = {}) {
    const tracer = {
      inject (_span, _format, carrier) {
        for (const [key, value] of Object.entries(headers)) {
          carrier[key] = value
        }
      },
    }

    const plugin = new AwsDurableExecutionSdkJsClientPlugin(tracer, {})
    plugin.startSpan = (_name, _options, ctx) => {
      ctx.currentStore = {
        span: {
          context () {
            return {}
          },
        },
      }
    }
    return plugin
  }

  it('injects _datadog into invoke(name, funcId, input) payloads', () => {
    const plugin = createPlugin({
      'x-datadog-trace-id': '111',
      'x-datadog-parent-id': '222',
      'x-datadog-sampling-priority': '1',
      'x-datadog-tags': '_dd.p.tid=abcdef0000000000',
      traceparent: '00-abcdef00000000000000000000000000-0000000000000222-01',
      tracestate: 'dd=t.tid:abcdef0000000000;s:1;p:0000000000000222',
    })

    const payload = { hello: 'world' }
    const ctx = {
      arguments: ['test-invoke', 'arn:aws:lambda:us-east-1:123456789012:function:target', payload],
    }

    plugin.bindStart(ctx)

    assert.deepEqual(payload._datadog, {
      'x-datadog-trace-id': '111',
      'x-datadog-parent-id': '222',
      'x-datadog-sampling-priority': '1',
      'x-datadog-tags': '_dd.p.tid=abcdef0000000000',
      traceparent: '00-abcdef00000000000000000000000000-0000000000000222-01',
      tracestate: 'dd=t.tid:abcdef0000000000;s:1;p:0000000000000222',
    })
  })

  it('injects _datadog into invoke(funcId, input) payloads', () => {
    const plugin = createPlugin({
      'x-datadog-trace-id': '333',
      'x-datadog-parent-id': '444',
    })

    const payload = { chain: true }
    const ctx = {
      arguments: ['arn:aws:lambda:us-east-1:123456789012:function:target', payload],
    }

    plugin.bindStart(ctx)

    assert.deepEqual(payload._datadog, {
      'x-datadog-trace-id': '333',
      'x-datadog-parent-id': '444',
    })
  })

  it('does not inject when invoke input is not a plain object', () => {
    const plugin = createPlugin({
      'x-datadog-trace-id': '555',
      'x-datadog-parent-id': '666',
    })

    const primitiveCtx = {
      arguments: ['test-invoke', 'arn:aws:lambda:us-east-1:123456789012:function:target', 42],
    }
    const arrayPayload = []
    const arrayCtx = {
      arguments: ['arn:aws:lambda:us-east-1:123456789012:function:target', arrayPayload],
    }
    const emptyInputCtx = {
      arguments: ['arn:aws:lambda:us-east-1:123456789012:function:target'],
    }

    plugin.bindStart(primitiveCtx)
    plugin.bindStart(arrayCtx)
    plugin.bindStart(emptyInputCtx)

    assert.equal(typeof primitiveCtx.arguments[2], 'number')
    assert.equal(arrayPayload._datadog, undefined)
    assert.equal(emptyInputCtx.arguments.length, 1)
  })
})

