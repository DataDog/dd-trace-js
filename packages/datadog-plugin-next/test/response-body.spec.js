'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const createJsonResponse = Response.json
const instrumentations = require('../../datadog-instrumentations/src/helpers/instrumentations')
require('../../datadog-instrumentations/src/next')

describe('Next.js JSON response hook', () => {
  const channel = dc.channel('apm:next:response:json')
  let hook, onBody, json, NextRequest

  beforeEach(() => {
    class RuntimeResponse extends Response {}
    json = sinon.spy(createJsonResponse)
    Object.defineProperty(RuntimeResponse, 'json', { value: json, writable: true, configurable: true })
    sinon.replace(globalThis, 'Response', RuntimeResponse)

    class RuntimeRequest {
      async text () {}
      async json () {}
      async formData () {}
    }
    NextRequest = class extends RuntimeRequest {}
    hook = instrumentations.next.find(hook => hook.file === 'dist/server/web/spec-extension/request.js').hook
    hook({ NextRequest })

    onBody = sinon.spy()
    channel.subscribe(onBody)
  })

  afterEach(() => {
    channel.unsubscribe(onBody)
    sinon.restore()
  })

  it('publishes the original object with the response status and preserves the result', async () => {
    const body = { value: 'café' }
    const response = Response.json(body, { status: 201, headers: { 'x-test': 'preserved' } })

    sinon.assert.calledOnceWithExactly(onBody, { body, statusCode: 201 }, channel.name)
    assert.strictEqual(onBody.firstCall.args[0].body, body)
    assert.strictEqual(response, json.firstCall.returnValue)
    assert.strictEqual(response.status, 201)
    assert.strictEqual(response.headers.get('x-test'), 'preserved')
    assert.deepStrictEqual(await response.json(), body)
  })

  it('does not publish when JSON serialization throws', () => {
    const body = {}
    body.circular = body

    assert.throws(() => Response.json(body), { name: 'TypeError' })
    sinon.assert.notCalled(onBody)
  })

  it('does not wrap the same runtime constructor twice', () => {
    hook({ NextRequest })
    Response.json({ value: 1 })
    sinon.assert.calledOnce(onBody)
    sinon.assert.calledOnce(json)
  })

  it('preserves JSON response creation without subscribers', async () => {
    channel.unsubscribe(onBody)
    const response = Response.json({ value: 1 })
    assert.strictEqual(response, json.firstCall.returnValue)
    assert.deepStrictEqual(await response.json(), { value: 1 })
    sinon.assert.notCalled(onBody)
  })
})
