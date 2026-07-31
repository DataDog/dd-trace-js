'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire')

describe('HTTP request-lifetime flush', () => {
  it('schedules native OTLP export after finishing the HTTP server span', () => {
    const calls = []
    const req = {}
    const context = { res: {} }
    const tracer = {}
    const HttpServerPlugin = proxyquire.noCallThru().load('../src/server', {
      '../../dd-trace/src/plugins/util/web': {
        getContext (receivedReq) {
          assert.strictEqual(receivedReq, req)
          return context
        },
        finishAll (receivedContext) {
          assert.strictEqual(receivedContext, context)
          calls.push('finish all')
        },
      },
      '../../dd-trace/src/serverless': {
        scheduleVercelFlush (scheduledTracer) {
          assert.strictEqual(scheduledTracer, tracer)
          calls.push('schedule flush')
        },
      },
    })
    const plugin = new HttpServerPlugin(tracer, {})

    plugin.finish({ req })

    assert.deepStrictEqual(calls, ['finish all', 'schedule flush'])
  })
})
