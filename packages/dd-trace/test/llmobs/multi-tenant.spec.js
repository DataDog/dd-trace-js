'use strict'

const assert = require('node:assert/strict')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

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

    BaseLLMObsWriter = proxyquire('../../src/llmobs/writers/base', {
      '../../exporters/common/request': request,
      '../../log': logger,
      './util': proxyquire('../../src/llmobs/writers/util', { '../../log': logger })
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
    const byKey = (key) => calls.find(c => c.args[1].headers['DD-API-KEY'] === key)

    const callA = byKey('key-a')
    const callB = byKey('key-b')
    const callDefault = byKey('default-key')

    assert.strictEqual(callA.args[1].url.href, 'https://intake.site-a.com/')
    assert.strictEqual(callB.args[1].url.href, 'https://intake.site-b.com/')
    assert.strictEqual(callDefault.args[1].url.href, 'https://intake.default-site.com/')
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
})
