'use strict'

const assert = require('node:assert/strict')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('Multi-Tenant Routing', () => {
  let BaseLLMObsWriter
  let request
  let logger

  beforeEach(() => {
    request = sinon.stub()
    logger = {
      debug: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub()
    }
    BaseLLMObsWriter = proxyquire('../../src/llmobs/writers/base', {
      '../../exporters/common/request': request,
      '../../log': logger,
      './util': proxyquire('../../src/llmobs/writers/util', {
        '../../log': logger
      })
    })
  })

  afterEach(() => {
    process.removeAllListeners('beforeExit')
  })

  describe('multi-buffer routing', () => {
    let writer
    const config = {
      site: 'default-site.com',
      hostname: 'localhost',
      port: 8126,
      apiKey: 'default-key'
    }

    beforeEach(() => {
      writer = new BaseLLMObsWriter({
        endpoint: '/endpoint',
        intake: 'intake',
        config
      })
      writer.setAgentless(true)
      writer.makePayload = (events) => ({ events })
    })

    afterEach(() => {
      writer.destroy()
    })

    it('routes events to different buffers based on routing key', () => {
      writer.append({ id: 1 }, { apiKey: 'key-a', site: 'site-a.com' })
      writer.append({ id: 2 }, { apiKey: 'key-b', site: 'site-b.com' })
      writer.append({ id: 3 }, { apiKey: 'key-a', site: 'site-a.com' })

      assert.strictEqual(writer._buffers.size, 2)

      const bufferA = writer._buffers.get('key-a:site-a.com')
      const bufferB = writer._buffers.get('key-b:site-b.com')

      assert.strictEqual(bufferA.events.length, 2)
      assert.strictEqual(bufferB.events.length, 1)
      assert.deepStrictEqual(bufferA.events.map(e => e.id), [1, 3])
      assert.deepStrictEqual(bufferB.events.map(e => e.id), [2])
    })

    it('uses default routing when no routing is provided', () => {
      writer.append({ id: 1 })
      writer.append({ id: 2 }, null)

      const defaultKey = `${config.apiKey}:${config.site}`
      assert.strictEqual(writer._buffers.size, 1)
      assert.strictEqual(writer._buffers.get(defaultKey).events.length, 2)
    })

    it('flushes each buffer to its corresponding endpoint', () => {
      writer.append({ id: 1 }, { apiKey: 'key-a', site: 'site-a.com' })
      writer.append({ id: 2 }, { apiKey: 'key-b', site: 'site-b.com' })

      writer.flush()

      assert.strictEqual(request.callCount, 2)

      const calls = request.getCalls()
      const options = calls.map(c => c.args[1])

      const optionsA = options.find(o => o.headers['DD-API-KEY'] === 'key-a')
      const optionsB = options.find(o => o.headers['DD-API-KEY'] === 'key-b')

      assert.ok(optionsA, 'Should have request with key-a')
      assert.ok(optionsB, 'Should have request with key-b')

      assert.strictEqual(optionsA.url.href, 'https://intake.site-a.com/')
      assert.strictEqual(optionsB.url.href, 'https://intake.site-b.com/')
    })

    it('clears buffers after flush', () => {
      writer.append({ id: 1 }, { apiKey: 'key-a', site: 'site-a.com' })

      assert.strictEqual(writer._buffers.get('key-a:site-a.com').events.length, 1)

      writer.flush()

      assert.strictEqual(writer._buffers.size, 0)
    })

    it('maintains separate buffer limits per routing key', () => {
      const routing = { apiKey: 'key-a', site: 'site-a.com' }

      for (let i = 0; i < 1000; i++) {
        writer.append({ id: i }, routing)
      }

      writer.append({ id: 'overflow' }, routing)

      const buffer = writer._buffers.get('key-a:site-a.com')
      assert.strictEqual(buffer.events.length, 1000)

      sinon.assert.calledWith(logger.warn,
        'BaseLLMObsWriter event buffer full (limit is 1000), dropping event'
      )
    })

    it('does not mix events between routing keys', () => {
      const routingA = { apiKey: 'key-a', site: 'site-a.com' }
      const routingB = { apiKey: 'key-b', site: 'site-b.com' }

      writer.append({ tenant: 'A', data: 'secret-A' }, routingA)
      writer.append({ tenant: 'B', data: 'secret-B' }, routingB)

      writer.flush()

      const calls = request.getCalls()
      const payloads = calls.map(c => JSON.parse(c.args[0]))

      const payloadA = payloads.find(p => p.events[0].tenant === 'A')
      const payloadB = payloads.find(p => p.events[0].tenant === 'B')

      assert.strictEqual(payloadA.events.length, 1)
      assert.strictEqual(payloadA.events[0].data, 'secret-A')

      assert.strictEqual(payloadB.events.length, 1)
      assert.strictEqual(payloadB.events[0].data, 'secret-B')
    })
  })

  describe('security', () => {
    it('does not include API key in payload', () => {
      const writer = new BaseLLMObsWriter({
        endpoint: '/endpoint',
        intake: 'intake',
        config: { site: 'site.com', apiKey: 'secret-key', hostname: 'localhost', port: 8126 }
      })
      writer.setAgentless(true)
      writer.makePayload = (events) => ({ events })

      writer.append({ data: 'test' }, { apiKey: 'tenant-secret-key', site: 'tenant.com' })
      writer.flush()

      const payload = request.getCall(0).args[0]
      assert.ok(!payload.includes('tenant-secret-key'), 'Payload should not contain API key')
      assert.ok(!payload.includes('secret-key'), 'Payload should not contain default API key')

      writer.destroy()
    })
  })
})
