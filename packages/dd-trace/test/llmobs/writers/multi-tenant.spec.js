'use strict'

const assert = require('node:assert/strict')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const LLMObsSpanWriter = require('../../../src/llmobs/writers/spans')
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

      tracer = require('../../../../dd-trace')
      tracer.init({
        service: 'service',
        llmobs: {
          mlApp: 'mlApp',
          agentlessEnabled: true
        }
      })
      llmobs = tracer.llmobs

      process.removeAllListeners('beforeExit')
    })

    beforeEach(() => {
      appendSpy = sinon.spy(LLMObsSpanWriter.prototype, 'append')
      flushStub = sinon.stub(LLMObsSpanWriter.prototype, 'flush')
      logWarnSpy = sinon.spy(log, 'warn')
    })

    afterEach(() => {
      appendSpy.restore()
      flushStub.restore()
      logWarnSpy.restore()
    })

    after(() => {
      delete process.env.DD_API_KEY
      delete process.env.DD_SITE
      llmobs.disable()
      agent.wipe()
    })

    it('nested contexts route spans correctly and log warning', () => {
      llmobs.withRoutingContext({ ddApiKey: 'outer-key', ddSite: 'outer-site.com' }, () => {
        llmobs.trace({ kind: 'workflow', name: 'outer-span' }, () => {})

        llmobs.withRoutingContext({ ddApiKey: 'inner-key', ddSite: 'inner-site.com' }, () => {
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

      sinon.assert.calledOnce(logWarnSpy)
      sinon.assert.calledWith(logWarnSpy, sinon.match(/Nested routing context detected/))
    })

    it('concurrent contexts are isolated', async () => {
      await Promise.all([
        llmobs.withRoutingContext({ ddApiKey: 'key-a', ddSite: 'site-a.com' }, async () => {
          await new Promise(resolve => setTimeout(resolve, 10))
          llmobs.trace({ kind: 'workflow', name: 'span-a' }, () => {})
        }),
        llmobs.withRoutingContext({ ddApiKey: 'key-b', ddSite: 'site-b.com' }, async () => {
          await new Promise(resolve => setTimeout(resolve, 5))
          llmobs.trace({ kind: 'workflow', name: 'span-b' }, () => {})
        })
      ])

      const calls = appendSpy.getCalls()
      const routingFor = (name) => calls.find(c => c.args[0].name === name).args[1]

      assert.deepStrictEqual(routingFor('span-a'), { apiKey: 'key-a', site: 'site-a.com' })
      assert.deepStrictEqual(routingFor('span-b'), { apiKey: 'key-b', site: 'site-b.com' })
    })
  })
})
