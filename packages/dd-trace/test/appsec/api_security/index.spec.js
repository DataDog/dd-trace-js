'use strict'

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()

describe('API Security domain', () => {
  describe('reportRequest', () => {
    let apiSecurity
    let sampler, web, telemetry, blocking, reporter
    let req, res

    beforeEach(() => {
      sampler = {
        configure: sinon.stub(),
        disable: sinon.stub(),
        sampleRequest: sinon.stub(),
        isEnabled: sinon.stub().returns(true),
        hasRoute: sinon.stub().returns(true),
      }

      web = {
        root: sinon.stub().returns({
          context: () => ({ _tags: { component: 'express' } }),
        }),
      }

      telemetry = {
        incrementApiSecRequestSchemaMetric: sinon.stub(),
        incrementApiSecRequestNoSchemaMetric: sinon.stub(),
        incrementApiSecMissingRouteMetric: sinon.stub(),
      }

      blocking = {
        isBlocked: sinon.stub().returns(false),
      }

      reporter = {
        isSchemaAttribute: (key) => key.startsWith('_dd.appsec.s.'),
      }

      apiSecurity = proxyquire('../../../src/appsec/api_security', {
        './sampler': sampler,
        '../../plugins/util/web': web,
        '../blocking': blocking,
        '../reporter': reporter,
        '../telemetry': telemetry,
      })

      req = {}
      res = { statusCode: 200 }
    })

    it('emits nothing when API security is disabled', () => {
      sampler.isEnabled.returns(false)

      apiSecurity.reportRequest(req, res, {
        sampled: true,
        wafResult: { attributes: { '_dd.appsec.s.req.body': [] } },
      })

      sinon.assert.notCalled(telemetry.incrementApiSecRequestSchemaMetric)
      sinon.assert.notCalled(telemetry.incrementApiSecRequestNoSchemaMetric)
      sinon.assert.notCalled(telemetry.incrementApiSecMissingRouteMetric)
    })

    it('emits nothing on 404 responses', () => {
      res.statusCode = 404
      sampler.hasRoute.returns(false)

      apiSecurity.reportRequest(req, res, { sampled: false, wafResult: undefined })

      sinon.assert.notCalled(telemetry.incrementApiSecMissingRouteMetric)
      sinon.assert.notCalled(telemetry.incrementApiSecRequestSchemaMetric)
      sinon.assert.notCalled(telemetry.incrementApiSecRequestNoSchemaMetric)
    })

    it('emits nothing on blocked responses', () => {
      blocking.isBlocked.returns(true)
      sampler.hasRoute.returns(false)

      apiSecurity.reportRequest(req, res, { sampled: false, wafResult: undefined })

      sinon.assert.notCalled(telemetry.incrementApiSecMissingRouteMetric)
      sinon.assert.notCalled(telemetry.incrementApiSecRequestSchemaMetric)
      sinon.assert.notCalled(telemetry.incrementApiSecRequestNoSchemaMetric)
    })

    it('emits missing_route with framework when no route is available', () => {
      sampler.hasRoute.returns(false)

      apiSecurity.reportRequest(req, res, { sampled: false, wafResult: undefined })

      sinon.assert.calledOnceWithExactly(telemetry.incrementApiSecMissingRouteMetric, 'express')
      sinon.assert.notCalled(telemetry.incrementApiSecRequestSchemaMetric)
      sinon.assert.notCalled(telemetry.incrementApiSecRequestNoSchemaMetric)
    })

    it('emits only missing_route when route is missing, even if schema was attempted (mutual exclusion)', () => {
      sampler.hasRoute.returns(false)

      apiSecurity.reportRequest(req, res, {
        sampled: true,
        wafResult: { attributes: { '_dd.appsec.s.req.body': [] } },
      })

      sinon.assert.calledOnceWithExactly(telemetry.incrementApiSecMissingRouteMetric, 'express')
      sinon.assert.notCalled(telemetry.incrementApiSecRequestSchemaMetric)
      sinon.assert.notCalled(telemetry.incrementApiSecRequestNoSchemaMetric)
    })

    it('emits nothing when route exists but request was not sampled', () => {
      apiSecurity.reportRequest(req, res, { sampled: false, wafResult: undefined })

      sinon.assert.notCalled(telemetry.incrementApiSecMissingRouteMetric)
      sinon.assert.notCalled(telemetry.incrementApiSecRequestSchemaMetric)
      sinon.assert.notCalled(telemetry.incrementApiSecRequestNoSchemaMetric)
    })

    it('emits request.schema when WAF returned schema attributes', () => {
      apiSecurity.reportRequest(req, res, {
        sampled: true,
        wafResult: {
          attributes: {
            '_dd.appsec.s.req.body': [],
            '_dd.appsec.s.req.headers': [],
          },
        },
      })

      sinon.assert.calledOnceWithExactly(telemetry.incrementApiSecRequestSchemaMetric, 'express')
      sinon.assert.notCalled(telemetry.incrementApiSecRequestNoSchemaMetric)
      sinon.assert.notCalled(telemetry.incrementApiSecMissingRouteMetric)
    })

    it('emits request.no_schema when WAF returned attributes without any schema', () => {
      apiSecurity.reportRequest(req, res, {
        sampled: true,
        wafResult: { attributes: { 'some.other.attribute': 'value' } },
      })

      sinon.assert.calledOnceWithExactly(telemetry.incrementApiSecRequestNoSchemaMetric, 'express')
      sinon.assert.notCalled(telemetry.incrementApiSecRequestSchemaMetric)
      sinon.assert.notCalled(telemetry.incrementApiSecMissingRouteMetric)
    })

    it('emits request.no_schema when WAF returned no attributes', () => {
      apiSecurity.reportRequest(req, res, { sampled: true, wafResult: { attributes: undefined } })

      sinon.assert.calledOnceWithExactly(telemetry.incrementApiSecRequestNoSchemaMetric, 'express')
    })

    it('emits request.no_schema when wafResult is undefined', () => {
      apiSecurity.reportRequest(req, res, { sampled: true, wafResult: undefined })

      sinon.assert.calledOnceWithExactly(telemetry.incrementApiSecRequestNoSchemaMetric, 'express')
    })

    it('passes through the framework component tag (normalization is the telemetry layer concern)', () => {
      web.root.returns({
        context: () => ({ _tags: { component: 'Next JS' } }),
      })

      apiSecurity.reportRequest(req, res, {
        sampled: true,
        wafResult: { attributes: { '_dd.appsec.s.req.body': [] } },
      })

      sinon.assert.calledOnceWithExactly(telemetry.incrementApiSecRequestSchemaMetric, 'Next JS')
    })
  })
})
