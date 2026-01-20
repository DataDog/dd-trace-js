'use strict'

const assert = require('node:assert/strict')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const LLMObsSpanWriter = require('../../../src/llmobs/writers/spans')
const LLMObsEvalMetricsWriter = require('../../../src/llmobs/writers/evaluations')
const log = require('../../../src/log')
const agent = require('../../plugins/agent')

describe('Multi-Tenant Routing', () => {
  let BaseLLMObsWriter
  let request
  let logger
  let writer

  const config = {
    site: 'default-site.com',
    hostname: 'localhost',
    port: 8126,
    apiKey: 'default-key'
  }

  beforeEach(() => {
    request = sinon.stub()
    logger = { debug: sinon.stub(), warn: sinon.stub(), error: sinon.stub() }

    BaseLLMObsWriter = proxyquire('../../../src/llmobs/writers/base', {
      '../../exporters/common/request': request,
      '../../log': logger,
      './util': proxyquire('../../../src/llmobs/writers/util', { '../../log': logger })
    })

    writer = new BaseLLMObsWriter({ endpoint: '/endpoint', intake: 'intake', config })
    writer.setAgentless(true)
    writer.makePayload = (events) => ({ events })
  })

  afterEach(() => {
    writer.destroy()
    process.removeAllListeners('beforeExit')
  })

  it('routes events to correct endpoints with correct API keys', () => {
    writer.append({ id: 1 }, { apiKey: 'key-a', site: 'site-a.com' })
    writer.append({ id: 2 }, { apiKey: 'key-b', site: 'site-b.com' })
    writer.append({ id: 3 }) // default routing

    writer.flush()

    assert.strictEqual(request.callCount, 3)

    const calls = request.getCalls()
    const byKey = (key) => calls.find(c => c.args[1].headers['DD-API-KEY'] === key).args[1].url.href

    assert.strictEqual(byKey('key-a'), 'https://intake.site-a.com/')
    assert.strictEqual(byKey('key-b'), 'https://intake.site-b.com/')
    assert.strictEqual(byKey('default-key'), 'https://intake.default-site.com/')
  })

  it('isolates events between tenants', () => {
    writer.append({ tenant: 'A', secret: 'A-data' }, { apiKey: 'key-a', site: 'site-a.com' })
    writer.append({ tenant: 'B', secret: 'B-data' }, { apiKey: 'key-b', site: 'site-b.com' })

    writer.flush()

    const payloads = request.getCalls().map(c => ({
      apiKey: c.args[1].headers['DD-API-KEY'],
      events: JSON.parse(c.args[0]).events
    }))

    const payloadA = payloads.find(p => p.apiKey === 'key-a')
    const payloadB = payloads.find(p => p.apiKey === 'key-b')

    assert.strictEqual(payloadA.events.length, 1)
    assert.strictEqual(payloadA.events[0].secret, 'A-data')
    assert.strictEqual(payloadB.events.length, 1)
    assert.strictEqual(payloadB.events[0].secret, 'B-data')
  })

  it('enforces buffer limit per routing key', () => {
    const routing = { apiKey: 'key-a', site: 'site-a.com' }

    for (let i = 0; i < 1001; i++) {
      writer.append({ id: i }, routing)
    }

    writer.flush()

    const payload = JSON.parse(request.getCall(0).args[0])
    assert.strictEqual(payload.events.length, 1000)
    sinon.assert.calledOnce(logger.warn)
  })

  it('clears buffers after flush', () => {
    writer.append({ id: 1 }, { apiKey: 'key-a', site: 'site-a.com' })

    writer.flush()
    assert.strictEqual(request.callCount, 1)

    writer.flush()
    assert.strictEqual(request.callCount, 1) // no new requests
  })

  it('does not include API key in payload body', () => {
    writer.append({ data: 'test' }, { apiKey: 'secret-tenant-key', site: 'tenant.com' })

    writer.flush()

    const payload = request.getCall(0).args[0]
    assert.ok(!payload.includes('secret-tenant-key'))
    assert.ok(!payload.includes('default-key'))
  })

  describe('routing context behavior', () => {
    let tracer
    let llmobs
    let appendSpy
    let flushStub
    let logWarnSpy

    before(() => {
      process.env.DD_API_KEY = 'test-api-key'
      process.env.DD_SITE = 'datadoghq.com'

      agent.wipe()

      tracer = require('../../../../dd-trace')
      tracer.init({
        service: 'service',
        llmobs: {
          mlApp: 'mlApp',
          agentlessEnabled: true
        }
      })
      llmobs = tracer.llmobs
    })

    let evalAppendSpy
    let evalFlushStub

    beforeEach(() => {
      appendSpy = sinon.spy(LLMObsSpanWriter.prototype, 'append')
      flushStub = sinon.stub(LLMObsSpanWriter.prototype, 'flush')
      evalAppendSpy = sinon.spy(LLMObsEvalMetricsWriter.prototype, 'append')
      evalFlushStub = sinon.stub(LLMObsEvalMetricsWriter.prototype, 'flush')
      logWarnSpy = sinon.spy(log, 'warn')
    })

    afterEach(() => {
      appendSpy.restore()
      flushStub.restore()
      evalAppendSpy.restore()
      evalFlushStub.restore()
      logWarnSpy.restore()
    })

    after(() => {
      delete process.env.DD_API_KEY
      delete process.env.DD_SITE
      agent.wipe()
    })

    it('nested contexts route spans correctly and log warning', () => {
      llmobs.routingContext({ ddApiKey: 'outer-key', ddSite: 'outer-site.com' }, () => {
        llmobs.trace({ kind: 'workflow', name: 'outer-span' }, () => {})

        llmobs.routingContext({ ddApiKey: 'inner-key', ddSite: 'inner-site.com' }, () => {
          llmobs.trace({ kind: 'workflow', name: 'inner-span' }, () => {})
        })

        llmobs.trace({ kind: 'workflow', name: 'after-inner-span' }, () => {})
      })

      const calls = appendSpy.getCalls()
      assert.strictEqual(calls.length, 3)

      const routingFor = (name) => calls.find(c => c.args[0].name === name).args[1]

      assert.deepStrictEqual(routingFor('outer-span'), { apiKey: 'outer-key', site: 'outer-site.com' })
      assert.deepStrictEqual(routingFor('inner-span'), { apiKey: 'inner-key', site: 'inner-site.com' })
      assert.deepStrictEqual(routingFor('after-inner-span'), { apiKey: 'outer-key', site: 'outer-site.com' })

      const warningMessages = logWarnSpy.getCalls().map(call => call.args[0])
      const nestedWarnings = warningMessages.filter(message => /Nested routing context detected/.test(message))
      assert.strictEqual(nestedWarnings.length, 1)
    })

    it('concurrent contexts are isolated', async () => {
      let resolveA
      let resolveB
      const gateA = new Promise(resolve => { resolveA = resolve })
      const gateB = new Promise(resolve => { resolveB = resolve })

      const taskA = llmobs.routingContext({ ddApiKey: 'key-a', ddSite: 'site-a.com' }, async () => {
        await gateA
        llmobs.trace({ kind: 'workflow', name: 'span-a' }, () => {})
      })
      const taskB = llmobs.routingContext({ ddApiKey: 'key-b', ddSite: 'site-b.com' }, async () => {
        await gateB
        llmobs.trace({ kind: 'workflow', name: 'span-b' }, () => {})
      })

      resolveB()
      resolveA()

      await Promise.all([taskA, taskB])

      const calls = appendSpy.getCalls()

      // explicit assertion that span-b is appended before span-a
      const callNames = calls.map(call => call.args[0].name)
      const spanBIndex = callNames.indexOf('span-b')
      const spanAIndex = callNames.indexOf('span-a')
      assert.ok(spanBIndex !== -1)
      assert.ok(spanAIndex !== -1)
      assert.ok(spanBIndex < spanAIndex)

      const routingFor = (name) => calls.find(c => c.args[0].name === name).args[1]

      assert.deepStrictEqual(routingFor('span-a'), { apiKey: 'key-a', site: 'site-a.com' })
      assert.deepStrictEqual(routingFor('span-b'), { apiKey: 'key-b', site: 'site-b.com' })
    })

    it('routes evaluations to correct tenant', () => {
      const spanContext = { traceId: '123', spanId: '456' }

      llmobs.routingContext({ ddApiKey: 'eval-key', ddSite: 'eval-site.com' }, () => {
        llmobs.submitEvaluation(spanContext, {
          label: 'test-label',
          metricType: 'score',
          value: 0.9
        })
      })

      assert.strictEqual(evalAppendSpy.callCount, 1)
      const [payload, routing] = evalAppendSpy.firstCall.args
      assert.strictEqual(payload.label, 'test-label')
      assert.deepStrictEqual(routing, { apiKey: 'eval-key', site: 'eval-site.com' })
    })

    it('evaluations outside routing context have no routing', () => {
      const spanContext = { traceId: '123', spanId: '456' }

      llmobs.submitEvaluation(spanContext, {
        label: 'default-label',
        metricType: 'categorical',
        value: 'good'
      })

      assert.strictEqual(evalAppendSpy.callCount, 1)
      const [payload, routing] = evalAppendSpy.firstCall.args
      assert.strictEqual(payload.label, 'default-label')
      assert.strictEqual(routing, undefined)
    })
  })
})
