'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire')

const { storage } = require('../../datadog-core')

describe('Next request-lifetime flush', () => {
  it('schedules native OTLP export after finishing a request without an HTTP parent', () => {
    const calls = []
    const { plugin } = createPlugin(calls)

    storage('legacy').run({ span: createSpan(calls) }, () => {
      plugin.finish({ req: {}, res: { statusCode: 200 } })
    })

    assert.deepStrictEqual(calls, ['finish span', 'schedule flush'])
  })

  it('leaves native OTLP export to HTTP after finishing a request with an HTTP parent', () => {
    const calls = []
    const { plugin } = createPlugin(calls)

    storage('legacy').run({ span: createSpan(calls), httpParentSpan: {} }, () => {
      plugin.finish({ req: {}, res: { statusCode: 200 } })
    })

    assert.deepStrictEqual(calls, ['finish span'])
  })
})

function createPlugin (calls) {
  const tracer = {
    _service: 'test-service',
    _nomenclature: {
      serviceName: () => ({ name: 'next-service', source: 'schema' }),
      opName: () => 'next.request',
    },
  }
  const NextPlugin = proxyquire.noCallThru().load('../src', {
    '../../dd-trace/src/serverless': {
      scheduleVercelFlush (scheduledTracer) {
        assert.strictEqual(scheduledTracer, tracer)
        calls.push('schedule flush')
      },
    },
    '../../dd-trace/src/plugins/util/web': { addError: () => {} },
  })
  const plugin = new NextPlugin(tracer, {})
  plugin.config = { hooks: { request: () => {} }, validateStatus: code => code < 500 }
  return { plugin, tracer }
}

function createSpan (calls) {
  const tags = {}
  return {
    addTags: newTags => Object.assign(tags, newTags),
    context: () => ({ getTag: key => tags[key] }),
    setTag: (key, value) => { tags[key] = value },
    finish: () => { calls.push('finish span') },
  }
}
