'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire')

const { storage } = require('../../datadog-core')

const legacyStorage = storage('legacy')

describe('Next request-lifetime flush', () => {
  for (const [name, requestError] of [
    ['successful request', undefined],
    ['failed request', new Error('route failed')],
  ]) {
    it(`schedules agentless export after finishing the span for a ${name}`, () => {
      const calls = []
      const tracer = createTracer(calls)
      const NextPlugin = proxyquire.noCallThru().load('../src', {
        '../../dd-trace/src/serverless': {
          scheduleVercelFlush (scheduledTracer) {
            assert.strictEqual(scheduledTracer, tracer)
            calls.push('schedule flush')
          },
        },
        '../../dd-trace/src/plugins/util/web': {
          addError: () => {},
        },
      })
      const plugin = new NextPlugin(tracer, {})
      const span = createSpan(calls)
      const req = { error: requestError }

      plugin.config = {
        hooks: { request: () => {} },
        validateStatus: code => code < 500,
      }

      legacyStorage.run({ span }, () => {
        plugin.finish({ req, res: { statusCode: requestError ? 500 : 200 } })
      })

      assert.deepStrictEqual(calls, ['finish span', 'schedule flush'])
    })
  }
})

function createTracer (calls) {
  return {
    _service: 'test-service',
    _nomenclature: {
      serviceName: () => ({ name: 'next-service', source: 'schema' }),
      opName: () => 'next.request',
    },
    calls,
  }
}

function createSpan (calls) {
  const tags = {}

  return {
    addTags: newTags => Object.assign(tags, newTags),
    context: () => ({ getTag: key => tags[key] }),
    setTag: (key, value) => {
      tags[key] = value
    },
    finish: () => {
      calls.push('finish span')
    },
  }
}
