'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const { getConfigFresh } = require('../../helpers/config')

describe('HTTP request normalization', () => {
  let handler, config, web, span, normalizeRoute, apiSecurity, reporter, req, res

  beforeEach(() => {
    req = { url: '/items/42', headers: {} }
    res = { statusCode: 200 }
    span = { setTag: sinon.spy() }
    web = { root: sinon.stub().returns(span), setRouteOrEndpointTag: sinon.spy() }
    normalizeRoute = sinon.stub().returns('/items/{id}')
    apiSecurity = {
      sampleRequest: sinon.stub().returns(0),
      SamplingDecision: { SAMPLE: 1 },
      reportRequest: sinon.spy(),
    }
    reporter = { finishRequest: sinon.spy() }
    handler = proxyquire('../../../src/appsec/handlers/http-request', {
      '../../plugins/util/web': web,
      '../api_security': apiSecurity,
      '../api_security/normalized-route': { normalizeRoute },
      '../reporter': reporter,
      '../waf': { disposeContext: sinon.spy() },
    })
    config = getConfigFresh({ appsec: { apiSecurity: { enabled: true } } })
    handler.setConfig(config)
  })

  afterEach(() => handler.setConfig(undefined))

  function finish () {
    handler.incomingHttpEndTranslator({ req, res })
  }

  it('normalizes after setting the route and tags the span before sampling', () => {
    finish()
    sinon.assert.calledOnceWithExactly(normalizeRoute, req)
    sinon.assert.calledOnceWithExactly(span.setTag, '_dd.appsec.normalized_route', '/items/{id}')
    assert.ok(web.setRouteOrEndpointTag.calledBefore(normalizeRoute))
    assert.ok(span.setTag.calledBefore(apiSecurity.sampleRequest))
  })

  it('does not normalize while API Security is disabled and resumes after re-enabling', () => {
    handler.setConfig(getConfigFresh({ appsec: { apiSecurity: { enabled: false } } }))
    finish()
    sinon.assert.notCalled(normalizeRoute)
    sinon.assert.notCalled(span.setTag)

    handler.setConfig(config)
    finish()
    sinon.assert.calledOnceWithExactly(normalizeRoute, req)
  })

  it('omits the tag if normalization cannot represent a route', () => {
    normalizeRoute.returns(null)
    finish()
    sinon.assert.calledOnce(normalizeRoute)
    sinon.assert.notCalled(span.setTag)
  })

  it('still samples and finishes the request if normalization fails', () => {
    normalizeRoute.throws(new Error('normalization failed'))
    finish()
    sinon.assert.notCalled(span.setTag)
    sinon.assert.calledOnce(apiSecurity.sampleRequest)
    sinon.assert.calledOnce(reporter.finishRequest)
  })
})
