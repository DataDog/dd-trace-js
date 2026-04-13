'use strict'

const assert = require('node:assert/strict')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { datadogOnRequestError } = require('../src/request-error')

describe('datadogOnRequestError', () => {
  let tracer
  let span
  let activeSpan

  const request = {
    path: '/api/users',
    method: 'GET',
    headers: { cookie: '_dd_s=id%3Dabc123%26created%3D1234' },
  }

  const context = {
    routerKind: 'App Router',
    routePath: '/api/users/[id]',
    routeType: 'route',
  }

  beforeEach(() => {
    span = {
      finish: sinon.spy(),
      setTag: sinon.spy(),
    }
    activeSpan = { name: 'parent-request' }
    tracer = {
      startSpan: sinon.stub().returns(span),
      scope: sinon.stub().returns({
        active: sinon.stub().returns(activeSpan),
      }),
    }
    global._ddtrace = tracer
  })

  afterEach(() => {
    delete global._ddtrace
  })

  it('should no-op when tracer is not available', () => {
    delete global._ddtrace

    datadogOnRequestError(new Error('test'), request, context)

    sinon.assert.notCalled(tracer.startSpan)
  })

  it('should create an error span parented to the active span', () => {
    datadogOnRequestError(new Error('test'), request, context)

    sinon.assert.calledOnce(tracer.startSpan)
    const [opName, opts] = tracer.startSpan.firstCall.args
    assert.equal(opName, 'nextjs.server_error')
    assert.equal(opts.childOf, activeSpan)
  })

  it('should set standard error tags from the error object', () => {
    const error = new Error('something broke')

    datadogOnRequestError(error, request, context)

    const [, opts] = tracer.startSpan.firstCall.args
    assert.equal(opts.tags['error.message'], 'something broke')
    assert.equal(opts.tags['error.type'], 'Error')
    assert.ok(opts.tags['error.stack'])
    assert.equal(opts.tags.error, true)
  })

  it('should handle undefined error gracefully', () => {
    datadogOnRequestError(undefined, request, context)

    const [, opts] = tracer.startSpan.firstCall.args
    assert.equal(opts.tags['error.message'], 'Unknown error')
    assert.equal(opts.tags['error.type'], 'Error')
    sinon.assert.calledOnce(span.finish)
  })

  it('should set route context tags', () => {
    datadogOnRequestError(new Error('test'), request, context)

    const [, opts] = tracer.startSpan.firstCall.args
    assert.equal(opts.tags['resource.name'], 'GET /api/users/[id]')
    assert.equal(opts.tags['http.method'], 'GET')
    assert.equal(opts.tags['http.url'], '/api/users')
    assert.equal(opts.tags['nextjs.router_kind'], 'App Router')
    assert.equal(opts.tags['nextjs.route_path'], '/api/users/[id]')
    assert.equal(opts.tags['nextjs.route_type'], 'route')
    assert.equal(opts.tags['span.kind'], 'server')
  })

  it('should set renderSource tag when present', () => {
    const ctxWithRender = { ...context, renderSource: 'react-server-components' }

    datadogOnRequestError(new Error('test'), request, ctxWithRender)

    sinon.assert.calledWith(span.setTag, 'nextjs.render_source', 'react-server-components')
  })

  it('should not set renderSource tag when absent', () => {
    datadogOnRequestError(new Error('test'), request, context)

    const renderCalls = span.setTag.getCalls().filter(c => c.args[0] === 'nextjs.render_source')
    assert.equal(renderCalls.length, 0)
  })

  it('should set error digest tag when present', () => {
    const error = new Error('test')
    error.digest = 'NEXT_NOT_FOUND'

    datadogOnRequestError(error, request, context)

    sinon.assert.calledWith(span.setTag, 'nextjs.error_digest', 'NEXT_NOT_FOUND')
  })

  it('should extract RUM session ID from _dd_s cookie', () => {
    const req = {
      ...request,
      headers: { cookie: '_dd_s=id=sess-123&created=1234&rum=1' },
    }

    datadogOnRequestError(new Error('test'), req, context)

    sinon.assert.calledWith(span.setTag, 'rum.session_id', 'sess-123')
  })

  it('should not set rum.session_id when no cookie header', () => {
    const req = { ...request, headers: {} }

    datadogOnRequestError(new Error('test'), req, context)

    const rumCalls = span.setTag.getCalls().filter(c => c.args[0] === 'rum.session_id')
    assert.equal(rumCalls.length, 0)
  })

  it('should finish the span', () => {
    datadogOnRequestError(new Error('test'), request, context)

    sinon.assert.calledOnce(span.finish)
  })
})
