'use strict'

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()

const { SamplingDecision } = require('../../../src/appsec/api_security/sampler')

describe('API Security domain', () => {
  describe('reportRequest', () => {
    let apiSecurity
    let sampler, web, telemetry, reporter
    let req, res

    beforeEach(() => {
      sampler = {
        configure: sinon.stub(),
        disable: sinon.stub(),
        sampleRequest: sinon.stub(),
        SamplingDecision,
      }

      web = {
        root: sinon.stub().returns({
          context: () => ({ _tags: { component: 'express' }, getTag: (key) => ({ component: 'express' })[key] }),
        }),
      }

      telemetry = {
        incrementApiSecRequestSchemaMetric: sinon.stub(),
        incrementApiSecRequestNoSchemaMetric: sinon.stub(),
        incrementApiSecMissingRouteMetric: sinon.stub(),
      }

      reporter = {
        isSchemaAttribute: (key) => key.startsWith('_dd.appsec.s.'),
      }

      apiSecurity = proxyquire('../../../src/appsec/api_security', {
        './sampler': sampler,
        '../../plugins/util/web': web,
        '../reporter': reporter,
        '../telemetry': telemetry,
      })

      req = {}
      res = { statusCode: 200 }
    })

    it('emits nothing on SKIP decision', () => {
      apiSecurity.reportRequest(req, SamplingDecision.SKIP, { attributes: { '_dd.appsec.s.req.body': [] } })

      sinon.assert.notCalled(telemetry.incrementApiSecRequestSchemaMetric)
      sinon.assert.notCalled(telemetry.incrementApiSecRequestNoSchemaMetric)
      sinon.assert.notCalled(telemetry.incrementApiSecMissingRouteMetric)
    })

    it('emits missing_route with framework tag on MISSING_ROUTE decision', () => {
      apiSecurity.reportRequest(req, SamplingDecision.MISSING_ROUTE, undefined)

      sinon.assert.calledOnceWithExactly(telemetry.incrementApiSecMissingRouteMetric, 'express')
      sinon.assert.notCalled(telemetry.incrementApiSecRequestSchemaMetric)
      sinon.assert.notCalled(telemetry.incrementApiSecRequestNoSchemaMetric)
    })

    it('emits request.schema on SAMPLE decision when WAF returned schema attributes', () => {
      apiSecurity.reportRequest(req, SamplingDecision.SAMPLE, {
        attributes: {
          '_dd.appsec.s.req.body': [],
          '_dd.appsec.s.req.headers': [],
        },
      })

      sinon.assert.calledOnceWithExactly(telemetry.incrementApiSecRequestSchemaMetric, 'express')
      sinon.assert.notCalled(telemetry.incrementApiSecRequestNoSchemaMetric)
      sinon.assert.notCalled(telemetry.incrementApiSecMissingRouteMetric)
    })

    it('emits request.no_schema on SAMPLE decision when WAF returned attributes without any schema', () => {
      apiSecurity.reportRequest(req, SamplingDecision.SAMPLE, { attributes: { 'some.other.attribute': 'value' } })

      sinon.assert.calledOnceWithExactly(telemetry.incrementApiSecRequestNoSchemaMetric, 'express')
      sinon.assert.notCalled(telemetry.incrementApiSecRequestSchemaMetric)
      sinon.assert.notCalled(telemetry.incrementApiSecMissingRouteMetric)
    })

    it('emits request.no_schema on SAMPLE decision when WAF returned no attributes', () => {
      apiSecurity.reportRequest(req, SamplingDecision.SAMPLE, { attributes: undefined })

      sinon.assert.calledOnceWithExactly(telemetry.incrementApiSecRequestNoSchemaMetric, 'express')
    })

    it('emits request.no_schema on SAMPLE decision when wafResult is undefined', () => {
      apiSecurity.reportRequest(req, SamplingDecision.SAMPLE, undefined)

      sinon.assert.calledOnceWithExactly(telemetry.incrementApiSecRequestNoSchemaMetric, 'express')
    })

    it('passes through the framework component tag (normalization is the telemetry layer concern)', () => {
      web.root.returns({
        context: () => ({ _tags: { component: 'Next JS' }, getTag: (key) => ({ component: 'Next JS' })[key] }),
      })

      apiSecurity.reportRequest(req, SamplingDecision.SAMPLE, { attributes: { '_dd.appsec.s.req.body': [] } })

      sinon.assert.calledOnceWithExactly(telemetry.incrementApiSecRequestSchemaMetric, 'Next JS')
    })
  })
})
