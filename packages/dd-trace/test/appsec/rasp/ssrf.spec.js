'use strict'

const { EventEmitter } = require('events')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const {
  httpClientRequestStart,
  httpClientResponseFinish,
} = require('../../../src/appsec/channels')
const addresses = require('../../../src/appsec/addresses')

const DEFAULT_URL = 'http://example.com'

describe('RASP - ssrf.js', () => {
  let waf
  let legacyStorage
  let downstream
  let ssrf
  let telemetry

  const makeCtx = (overrides = {}) => ({
    args: {
      uri: DEFAULT_URL,
      options: {},
    },
    abortController: {},
    ...overrides,
  })

  const stubStore = (req = {}, res = {}) => {
    legacyStorage.getStore.returns({ req, res })
    return { req, res }
  }

  const publishRequestStart = ({ ctx, includeBodies = false, requestAddresses = {} }) => {
    downstream.shouldSampleBody.returns(includeBodies)
    downstream.extractRequestData.returns(requestAddresses)
    httpClientRequestStart.publish(ctx)
  }

  const createResponse = ({ statusCode = 200, headers = {} } = {}) => {
    const response = new EventEmitter()
    response.statusCode = statusCode
    response.headers = headers
    return response
  }

  beforeEach(() => {
    legacyStorage = {
      getStore: sinon.stub(),
    }

    waf = {
      run: sinon.stub(),
    }

    downstream = {
      enable: sinon.stub(),
      disable: sinon.stub(),
      shouldSampleBody: sinon.stub().returns(true),
      handleRedirectResponse: sinon.stub().returns(false),
      extractRequestData: sinon.stub().returns({}),
      extractResponseData: sinon.stub().returns({}),
      incrementDownstreamAnalysisCount: sinon.stub(),
      storeRedirectBodyCollectionDecision: sinon.stub(),
    }

    telemetry = {
      updateRaspRuleMatchMetricTags: sinon.stub(),
    }

    ssrf = proxyquire('../../../src/appsec/rasp/ssrf', {
      '../../../../datadog-core': { storage: () => legacyStorage },
      '../waf': waf,
      '../downstream_requests': downstream,
      '../telemetry': telemetry,
    })

    const config = {
      appsec: {
        stackTrace: {
          enabled: true,
          maxStackTraces: 2,
          maxDepth: 42,
        },
      },
    }

    ssrf.enable(config)
  })

  afterEach(() => {
    sinon.restore()
    ssrf.disable()
  })

  describe('analyzeSsrf', () => {
    it('should analyze ssrf', () => {
      const ctx = makeCtx()
      const { req } = stubStore({}, {})

      publishRequestStart({
        ctx,
        includeBodies: false,
        requestAddresses: { [addresses.HTTP_OUTGOING_METHOD]: 'GET' },
      })

      sinon.assert.calledOnceWithExactly(
        waf.run,
        {
          ephemeral: {
            [addresses.HTTP_OUTGOING_URL]: DEFAULT_URL,
            [addresses.HTTP_OUTGOING_METHOD]: 'GET',
          },
        },
        req,
        { type: 'ssrf', variant: 'request' }
      )
    })

    it('should not analyze ssrf if rasp is disabled', () => {
      ssrf.disable()

      const ctx = makeCtx()
      stubStore({}, {})

      httpClientRequestStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze ssrf if no store', () => {
      const ctx = makeCtx()
      legacyStorage.getStore.returns(undefined)

      httpClientRequestStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze ssrf if no req', () => {
      const ctx = makeCtx()
      stubStore(null, {})

      httpClientRequestStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze ssrf if no url', () => {
      const ctx = makeCtx({ args: { uri: null, options: {} } })
      stubStore({}, {})

      httpClientRequestStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('does not set shouldCollectBody flag when sampling disabled', () => {
      const ctx = makeCtx()
      stubStore({}, {})

      publishRequestStart({ ctx, includeBodies: false })

      sinon.assert.match(ctx.shouldCollectBody, false)
    })

    it('evaluates response and passes body through to extractResponseData', () => {
      const ctx = makeCtx()
      const { req } = stubStore({}, {})

      const requestAddresses = { [addresses.HTTP_OUTGOING_METHOD]: 'POST' }
      const responseAddresses = {
        [addresses.HTTP_OUTGOING_RESPONSE_STATUS]: '200',
        [addresses.HTTP_OUTGOING_RESPONSE_BODY]: { ok: true },
      }

      downstream.extractResponseData.returns(responseAddresses)
      waf.run.onFirstCall().returns({ events: [] })
      waf.run.onSecondCall().returns({ events: [{ id: 'ssrf' }] })

      publishRequestStart({ ctx, includeBodies: true, requestAddresses })

      const response = createResponse({ headers: { 'content-type': 'application/json' } })
      const body = Buffer.from('{"ok":true}')

      httpClientResponseFinish.publish({ ctx, res: response, body })

      sinon.assert.calledWith(downstream.extractResponseData, response, body)
      sinon.assert.calledOnceWithExactly(downstream.incrementDownstreamAnalysisCount, req)
      sinon.assert.calledWith(
        telemetry.updateRaspRuleMatchMetricTags, req, { type: 'ssrf', variant: 'response' }, false, false)
      sinon.assert.calledTwice(waf.run)
    })

    it('evaluates response without body when body is null', () => {
      const ctx = makeCtx()
      const { req } = stubStore({}, {})

      downstream.extractResponseData.returns({
        [addresses.HTTP_OUTGOING_RESPONSE_STATUS]: '200',
      })
      waf.run.returns({ events: [] })

      publishRequestStart({ ctx, includeBodies: false })

      const response = createResponse()
      httpClientResponseFinish.publish({ ctx, res: response, body: null })

      sinon.assert.calledWith(downstream.extractResponseData, response, null)
      sinon.assert.calledOnceWithExactly(downstream.incrementDownstreamAnalysisCount, req)
      sinon.assert.calledTwice(waf.run)
    })

    it('does not call response evaluation when no response addresses', () => {
      const ctx = makeCtx()
      const { req } = stubStore({}, {})

      downstream.extractResponseData.returns({})
      waf.run.returns({ events: [] })

      publishRequestStart({ ctx, includeBodies: false })

      const response = createResponse()
      httpClientResponseFinish.publish({ ctx, res: response, body: null })

      sinon.assert.calledOnceWithExactly(downstream.incrementDownstreamAnalysisCount, req)
      sinon.assert.calledOnce(waf.run) // only for request
    })

    it('handles redirect responses and skips body analysis', () => {
      const ctx = makeCtx()
      const { req } = stubStore({}, {})

      downstream.handleRedirectResponse.returns(true)
      downstream.extractResponseData.returns({
        [addresses.HTTP_OUTGOING_RESPONSE_STATUS]: '302',
        [addresses.HTTP_OUTGOING_RESPONSE_HEADERS]: { location: 'http://example.com/redirect' },
      })
      waf.run.returns({ events: [] })

      publishRequestStart({ ctx, includeBodies: true })

      const response = createResponse({ statusCode: 302, headers: { location: 'http://example.com/redirect' } })
      const body = Buffer.from('redirect body')
      httpClientResponseFinish.publish({ ctx, res: response, body })

      sinon.assert.calledOnceWithExactly(downstream.handleRedirectResponse, req, response)

      sinon.assert.calledWith(downstream.extractResponseData, response, null)

      sinon.assert.calledTwice(waf.run)
    })

    it('passes body for non-redirect responses', () => {
      const ctx = makeCtx()
      stubStore({}, {})

      downstream.handleRedirectResponse.returns(false)
      downstream.extractResponseData.returns({
        [addresses.HTTP_OUTGOING_RESPONSE_STATUS]: '200',
        [addresses.HTTP_OUTGOING_RESPONSE_BODY]: { ok: true },
      })
      waf.run.returns({ events: [] })

      publishRequestStart({ ctx, includeBodies: true })

      const response = createResponse({ statusCode: 200 })
      const body = Buffer.from('{"ok":true}')
      httpClientResponseFinish.publish({ ctx, res: response, body })

      sinon.assert.calledWith(downstream.extractResponseData, response, body)
    })

    it('does not store redirect decision when shouldCollectBody is false', () => {
      const ctx = makeCtx()
      stubStore({}, {})

      publishRequestStart({ ctx, includeBodies: false })

      const response = createResponse({ statusCode: 302, headers: { location: 'http://example.com/redirect' } })
      httpClientResponseFinish.publish({ ctx, res: response, body: null })

      sinon.assert.notCalled(downstream.storeRedirectBodyCollectionDecision)
    })

    it('passes null body when shouldCollectBody is false even for non-redirect', () => {
      const ctx = makeCtx()
      stubStore({}, {})

      downstream.handleRedirectResponse.returns(false)
      downstream.extractResponseData.returns({
        [addresses.HTTP_OUTGOING_RESPONSE_STATUS]: '200',
      })
      waf.run.returns({ events: [] })

      publishRequestStart({ ctx, includeBodies: false })

      const response = createResponse({ statusCode: 200 })
      const body = Buffer.from('{"data":"test"}')
      httpClientResponseFinish.publish({ ctx, res: response, body })

      sinon.assert.calledWith(downstream.extractResponseData, response, null)
    })
  })
})
