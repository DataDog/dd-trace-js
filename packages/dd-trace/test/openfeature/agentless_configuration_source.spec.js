'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

const VALID_UFC = JSON.stringify({
  createdAt: '2026-01-01T00:00:00.000Z',
  format: 'SERVER',
  environment: { name: 'test' },
  flags: {},
})

describe('AgentlessConfigurationSource', () => {
  let AgentlessConfigurationSource
  let applyConfiguration
  let clock
  let config
  let log
  let requests
  let responses
  let transport

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    applyConfiguration = sinon.stub()
    config = {
      endpoint: new URL('http://127.0.0.1:8080/api/v2/feature-flagging/config/rules-based/server'),
      allowRawConfiguration: true,
      pollIntervalMs: 30_000,
      requestTimeoutMs: 2000,
      apiKey: 'test-api-key',
    }
    log = {
      debug: sinon.spy(),
      warn: sinon.spy(),
    }
    requests = []
    responses = []
    transport = {
      request: sinon.spy((url, options, onResponse) => {
        const request = new EventEmitter()
        request.url = url
        request.options = options
        request.setTimeout = sinon.spy((timeout, onTimeout) => {
          request.timeout = timeout
          request.onTimeout = onTimeout
        })
        request.destroy = sinon.spy(error => {
          if (error) request.emit('error', error)
        })
        request.end = sinon.spy(() => {
          const next = responses.shift()
          if (!next || next.pending) return
          if (next.error) {
            request.emit('error', next.error)
            return
          }
          const response = new EventEmitter()
          response.statusCode = next.statusCode
          response.headers = next.headers || {}
          onResponse(response)
          if (next.body) response.emit('data', Buffer.from(next.body))
          response.emit('end')
        })
        requests.push(request)
        return request
      }),
    }
    AgentlessConfigurationSource = proxyquire('../../src/openfeature/agentless_configuration_source', {
      'node:http': transport,
      '../log': log,
    })
  })

  afterEach(() => {
    clock.restore()
  })

  function source (options = {}) {
    return new AgentlessConfigurationSource(config, applyConfiguration, {
      http: transport,
      random: () => 0.5,
      ...options,
    })
  }

  function completeScheduledResponse () {
    clock.tick(0)
  }

  it('fetches, applies, and reuses the accepted ETag', () => {
    responses.push(
      { statusCode: 200, headers: { etag: '"ufc-v1"' }, body: VALID_UFC },
      { statusCode: 304, headers: {}, body: '' }
    )
    const configurationSource = source()
    const first = sinon.spy()
    const second = sinon.spy()

    configurationSource.pollOnce(first)
    completeScheduledResponse()
    configurationSource.pollOnce(second)
    completeScheduledResponse()

    sinon.assert.calledOnceWithExactly(applyConfiguration, JSON.parse(VALID_UFC))
    sinon.assert.calledWith(first, null, { applied: true })
    sinon.assert.calledWith(second, null, { notModified: true })
    assert.strictEqual(requests[0].options.headers['DD-API-KEY'], 'test-api-key')
    assert.strictEqual(requests[0].options.headers['If-None-Match'], undefined)
    assert.strictEqual(requests[1].options.headers['If-None-Match'], '"ufc-v1"')
    assert.strictEqual(requests[0].timeout, 2000)
  })

  it('unwraps a JSON API Universal Flag Configuration response', () => {
    const expected = JSON.parse(VALID_UFC)
    delete expected.format
    responses.push({
      statusCode: 200,
      body: JSON.stringify({
        data: {
          id: '1',
          type: 'universal-flag-configuration',
          attributes: expected,
        },
      }),
    })

    source().pollOnce(() => {})

    sinon.assert.calledOnceWithExactly(applyConfiguration, expected)
  })

  it('accepts managed JSON API payloads larger than 500 KB', () => {
    config.allowRawConfiguration = false
    const expected = JSON.parse(VALID_UFC)
    expected.flags.large = { description: 'x'.repeat(500 * 1024) }
    responses.push({
      statusCode: 200,
      body: JSON.stringify({
        data: {
          id: 'opaque-id',
          type: 'universal-flag-configuration',
          attributes: expected,
        },
      }),
    })

    source().pollOnce(() => {})

    sinon.assert.calledOnceWithExactly(applyConfiguration, expected)
  })

  it('requires JSON API at the first-party endpoint', () => {
    config.allowRawConfiguration = false
    responses.push({ statusCode: 200, body: VALID_UFC })

    source().pollOnce(() => {})

    sinon.assert.notCalled(applyConfiguration)
    sinon.assert.calledOnce(log.debug)
  })
})
