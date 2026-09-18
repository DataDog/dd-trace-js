'use strict'

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()

const { SamplingDecision } = require('../../../src/appsec/api_security/sampler')

describe('API Security domain', () => {
  describe('reportRequest', () => {
    let apiSecurity
    let sampler, web, telemetry, reporter
    let req

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
    })

    it('emits nothing on SKIP decision', () => {
      apiSecurity.reportRequest(req, SamplingDecision.SKIP, { attributes: { '_dd.appsec.s.req.body': [] } })

      sinon.assert.notCalled(telemetry.incrementApiSecRequestSchemaMetric)
      sinon.assert.notCalled(telemetry.incrementApiSecRequestNoSchemaMetric)
      sinon.assert.notCalled(telemetry.incrementApiSecMissingRouteMetric)
    })

    it('does not resolve the root span on SKIP decision', () => {
      apiSecurity.reportRequest(req, SamplingDecision.SKIP, undefined)

      sinon.assert.notCalled(web.root)
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

    describe('reportRootSpanRequest', () => {
      function makeRootSpan (component) {
        return { context: () => ({ getTag: (key) => ({ component })[key] }) }
      }

      it('reads the framework off the span without going through the HTTP transport', () => {
        apiSecurity.reportRootSpanRequest(makeRootSpan('aws-lambda'), SamplingDecision.SAMPLE, {
          attributes: { '_dd.appsec.s.req.body': [] },
        })

        sinon.assert.notCalled(web.root)
        sinon.assert.calledOnceWithExactly(telemetry.incrementApiSecRequestSchemaMetric, 'aws-lambda')
      })

      it('emits missing_route on MISSING_ROUTE decision', () => {
        apiSecurity.reportRootSpanRequest(makeRootSpan('aws-lambda'), SamplingDecision.MISSING_ROUTE, undefined)

        sinon.assert.calledOnceWithExactly(telemetry.incrementApiSecMissingRouteMetric, 'aws-lambda')
      })

      it('emits nothing on SKIP decision', () => {
        apiSecurity.reportRootSpanRequest(makeRootSpan('aws-lambda'), SamplingDecision.SKIP, {
          attributes: { '_dd.appsec.s.req.body': [] },
        })

        sinon.assert.notCalled(telemetry.incrementApiSecRequestSchemaMetric)
        sinon.assert.notCalled(telemetry.incrementApiSecRequestNoSchemaMetric)
        sinon.assert.notCalled(telemetry.incrementApiSecMissingRouteMetric)
      })

      it('emits request.no_schema when the WAF returned no schema attributes', () => {
        apiSecurity.reportRootSpanRequest(makeRootSpan('aws-lambda'), SamplingDecision.SAMPLE, undefined)

        sinon.assert.calledOnceWithExactly(telemetry.incrementApiSecRequestNoSchemaMetric, 'aws-lambda')
      })

      it('tolerates a missing root span', () => {
        apiSecurity.reportRootSpanRequest(undefined, SamplingDecision.SAMPLE, undefined)

        sinon.assert.calledOnceWithExactly(telemetry.incrementApiSecRequestNoSchemaMetric, undefined)
      })

      it('tolerates a root span without context()', () => {
        apiSecurity.reportRootSpanRequest({}, SamplingDecision.SAMPLE, undefined)

        sinon.assert.calledOnceWithExactly(telemetry.incrementApiSecRequestNoSchemaMetric, undefined)
      })

      it('tolerates a root span whose context() returns undefined', () => {
        apiSecurity.reportRootSpanRequest({ context: () => undefined }, SamplingDecision.MISSING_ROUTE, undefined)

        sinon.assert.calledOnceWithExactly(telemetry.incrementApiSecMissingRouteMetric, undefined)
      })
    })
  })
})
