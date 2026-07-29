'use strict'

const assert = require('node:assert/strict')

const { describe, it, afterEach } = require('mocha')
const proxyquire = require('proxyquire')

const { storage } = require('../../datadog-core')

const legacyStorage = storage('legacy')
const vercelRequestContext = Symbol.for('@vercel/request-context')

describe('Next request-lifetime flush', () => {
  const originalVercel = process.env.VERCEL

  afterEach(() => {
    if (originalVercel === undefined) delete process.env.VERCEL
    else process.env.VERCEL = originalVercel
    delete globalThis[vercelRequestContext]
  })

  it('schedules export after finishing the request span', () => {
    const calls = []
    const tracer = createTracer(calls)
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

    legacyStorage.run({ span: createSpan(calls) }, () => {
      plugin.finish({ req: {}, res: { statusCode: 200 } })
    })

    assert.deepStrictEqual(calls, ['finish span', 'schedule flush'])
  })

  it('keeps the real agentless export alive until its callback completes', async () => {
    process.env.VERCEL = '1'
    let done
    let requestTask
    const tracer = createTracer([], callback => { done = callback })
    const NextPlugin = proxyquire.noCallThru().load('../src', {
      '../../dd-trace/src/plugins/util/web': { addError: () => {} },
    })
    const plugin = new NextPlugin(tracer, {})
    plugin.config = { hooks: { request: () => {} }, validateStatus: code => code < 500 }
    globalThis[vercelRequestContext] = { get: () => ({ waitUntil: promise => { requestTask = promise } }) }

    legacyStorage.run({ span: createSpan([]) }, () => {
      plugin.finish({ req: {}, res: { statusCode: 200 } })
    })

    await nextImmediate()
    assert.strictEqual(typeof done, 'function')
    done()
    await requestTask
  })
})

function createTracer (calls, flush) {
  return {
    _config: { experimental: { exporter: 'agentless' } },
    _exporter: { flush: flush || assert.fail },
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
    setTag: (key, value) => { tags[key] = value },
    finish: () => { calls.push('finish span') },
  }
}

function nextImmediate () {
  return new Promise(resolve => setImmediate(resolve))
}
