'use strict'

const assert = require('node:assert/strict')
const { URL } = require('node:url')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const { assertObjectContains } = require('../../../../../integration-tests/helpers')
require('../../setup/core')

describe('AgentlessWriter', () => {
  let Writer
  let writer
  let request
  let encoder
  let url
  let log
  let getValueFromEnvSources

  beforeEach(() => {
    request = sinon.stub().yieldsAsync(null, '{}', 200)
    request.writable = true

    encoder = {
      encode: sinon.stub(),
      count: sinon.stub().returns(0),
      makePayload: sinon.stub().returns(Buffer.from('{"spans":[]}')),
      reset: sinon.stub(),
    }

    url = new URL('https://public-trace-http-intake.logs.datadoghq.com')

    log = {
      debug: sinon.spy(),
      error: sinon.spy(),
    }

    getValueFromEnvSources = sinon.stub().returns('test-api-key')

    const AgentlessJSONEncoder = function () {
      return encoder
    }

    const requestModule = Object.assign(request, { '@global': true })

    Writer = proxyquire('../../../src/exporters/agentless/writer', {
      '../common/request': requestModule,
      '../../encode/agentless-json': { AgentlessJSONEncoder },
      '../../../../../package.json': { version: 'tracerVersion' },
      '../../log': log,
      '../../config/helper': { getValueFromEnvSources },
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('constructor', () => {
    it('should construct intake URL from site', () => {
      writer = new Writer({ site: 'datadoghq.eu' })

      assert.ok(writer._url)
      assert.strictEqual(writer._url.hostname, 'public-trace-http-intake.logs.datadoghq.eu')
    })

    it('should use provided URL', () => {
      const customUrl = new URL('https://custom-intake.example.com')
      writer = new Writer({ url: customUrl, site: 'datadoghq.com' })

      assert.strictEqual(writer._url, customUrl)
    })

    it('should default to datadoghq.com site', () => {
      writer = new Writer({})

      assert.strictEqual(writer._url.hostname, 'public-trace-http-intake.logs.datadoghq.com')
    })
  })

  describe('append', () => {
    beforeEach(() => {
      writer = new Writer({ url })
    })

    it('should append a trace', () => {
      const span = { name: 'test' }
      writer.append([span])

      sinon.assert.calledWith(encoder.encode, [span])
    })
  })

  describe('flush', () => {
    beforeEach(() => {
      writer = new Writer({ url })
    })

    it('should skip flushing if empty', () => {
      writer.flush()

      sinon.assert.notCalled(encoder.makePayload)
    })

    it('should call callback when empty', (done) => {
      writer.flush(done)
    })

    it('should flush spans to the intake with correct headers', (done) => {
      const expectedData = Buffer.from('{"spans":[]}')

      encoder.count.returns(1)
      encoder.makePayload.returns(expectedData)

      writer.flush(() => {
        assert.deepStrictEqual(request.getCall(0).args[0], expectedData)
        assertObjectContains(request.getCall(0).args[1], {
          url,
          path: '/v1/input',
          method: 'POST',
          timeout: 15_000,
          headers: {
            'Content-Type': 'application/json',
            'dd-api-key': 'test-api-key',
            'Datadog-Meta-Lang': 'nodejs',
            'Datadog-Meta-Lang-Version': process.version,
            'Datadog-Meta-Lang-Interpreter': 'v8',
            'Datadog-Meta-Tracer-Version': 'tracerVersion',
          },
        })
        done()
      })
    })

    it('should log error at startup when API key is missing', () => {
      getValueFromEnvSources.returns(undefined)

      // Error should be logged at constructor time
      writer = new Writer({ url })

      sinon.assert.calledOnce(log.error)
      const call = log.error.getCall(0)
      assert.ok(call.args[0].includes('DD_API_KEY is required'))
      assert.ok(call.args[0].includes('Set the DD_API_KEY environment variable'))
    })

    it('should skip sending when API key is missing', (done) => {
      getValueFromEnvSources.returns(undefined)
      writer = new Writer({ url })

      encoder.count.returns(1)

      // Clear error log from constructor
      log.error.resetHistory()

      writer.flush(() => {
        // Should not call request when API key is missing
        sinon.assert.notCalled(request)
        // Should only log debug, not error (error was at startup)
        sinon.assert.notCalled(log.error)
        done()
      })
    })

    it('should skip sending empty payload', (done) => {
      encoder.count.returns(1)
      encoder.makePayload.returns(Buffer.alloc(0))

      writer.flush(() => {
        sinon.assert.notCalled(request)
        sinon.assert.calledWithMatch(log.debug, 'Skipping send of empty payload')
        done()
      })
    })

    it('should log authentication errors with guidance for 401', (done) => {
      const error = new Error('unauthorized')

      request.yields(error, null, 401)

      encoder.count.returns(1)

      writer.flush(() => {
        sinon.assert.calledOnce(log.error)
        const call = log.error.getCall(0)
        assert.ok(call.args[0].includes('Authentication failed'))
        assert.ok(call.args[0].includes('Verify DD_API_KEY'))
        done()
      })
    })

    it('should log authentication errors with guidance for 403', (done) => {
      const error = new Error('forbidden')

      request.yields(error, null, 403)

      encoder.count.returns(1)

      writer.flush(() => {
        sinon.assert.calledOnce(log.error)
        const call = log.error.getCall(0)
        assert.ok(call.args[0].includes('Authentication failed'))
        assert.ok(call.args[0].includes('Verify DD_API_KEY'))
        done()
      })
    })

    it('should log 404 errors with site guidance', (done) => {
      const error = new Error('not found')

      request.yields(error, null, 404)

      encoder.count.returns(1)

      writer.flush(() => {
        sinon.assert.calledOnce(log.error)
        const call = log.error.getCall(0)
        assert.ok(call.args[0].includes('endpoint not found'))
        assert.ok(call.args[0].includes('DD_SITE'))
        done()
      })
    })

    it('should log rate limit errors', (done) => {
      const error = new Error('too many requests')

      request.yields(error, null, 429)

      encoder.count.returns(1)

      writer.flush(() => {
        sinon.assert.calledOnce(log.error)
        const call = log.error.getCall(0)
        assert.ok(call.args[0].includes('Rate limited'))
        done()
      })
    })

    it('should log server errors as transient', (done) => {
      const error = new Error('internal server error')

      request.yields(error, null, 500)

      encoder.count.returns(1)

      writer.flush(() => {
        sinon.assert.calledOnce(log.error)
        const call = log.error.getCall(0)
        assert.ok(call.args[0].includes('server error'))
        assert.ok(call.args[0].includes('transient'))
        done()
      })
    })

    it('should log network errors with hostname', (done) => {
      const error = new Error('ECONNREFUSED')

      request.yields(error, null, undefined)

      encoder.count.returns(1)

      writer.flush(() => {
        sinon.assert.calledOnce(log.error)
        const call = log.error.getCall(0)
        assert.ok(call.args[0].includes('Network error'))
        done()
      })
    })

    it('should log generic errors for other status codes', (done) => {
      const error = new Error('bad request')

      request.yields(error, null, 400)

      encoder.count.returns(1)

      writer.flush(() => {
        sinon.assert.calledOnce(log.error)
        const call = log.error.getCall(0)
        assert.ok(call.args[0].includes('Error sending agentless payload'))
        // Status code is passed as second argument (printf-style)
        assert.strictEqual(call.args[1], 400)
        done()
      })
    })

    it('should reset encoder and skip request when not writable', (done) => {
      request.writable = false

      encoder.count.returns(1)

      writer.flush(() => {
        sinon.assert.notCalled(request)
        sinon.assert.calledOnce(encoder.reset)
        done()
      })
    })
  })

  describe('setUrl', () => {
    beforeEach(() => {
      writer = new Writer({ url })
    })

    it('should update the URL', () => {
      const newUrl = new URL('https://new-intake.example.com')
      writer.setUrl(newUrl)

      encoder.count.returns(1)
      writer.flush()

      assertObjectContains(request.getCall(0).args[1], { url: newUrl })
    })
  })

  describe('Bun runtime', () => {
    let originalBun

    beforeEach(() => {
      originalBun = process.versions.bun
      process.versions.bun = '1.0.0'
      writer = new Writer({ url })
    })

    afterEach(() => {
      if (originalBun === undefined) {
        delete process.versions.bun
      } else {
        process.versions.bun = originalBun
      }
    })

    it('should use JavaScriptCore interpreter header for Bun', (done) => {
      encoder.count.returns(1)

      writer.flush(() => {
        assertObjectContains(request.getCall(0).args[1], {
          headers: {
            'Datadog-Meta-Lang-Interpreter': 'JavaScriptCore',
          },
        })
        done()
      })
    })
  })
})
