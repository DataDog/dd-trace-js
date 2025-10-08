'use strict'

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const { EventEmitter } = require('events')

const {
  httpClientRequestStart,
  httpClientResponseData,
  httpClientResponseFinish
} = require('../../../src/appsec/channels')
const addresses = require('../../../src/appsec/addresses')

const DEFAULT_URL = 'http://example.com'

describe('RASP - ssrf.js', () => {
  let waf
  let legacyStorage
  let downstream
  let ssrf

  const makeCtx = (overrides = {}) => ({
    args: {
      uri: DEFAULT_URL,
      options: {}
    },
    abortController: {},
    ...overrides
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
      getStore: sinon.stub()
    }

    waf = {
      run: sinon.stub()
    }

    downstream = {
      enable: sinon.stub(),
      disable: sinon.stub(),
      shouldSampleBody: sinon.stub().returns(false),
      extractRequestData: sinon.stub().returns({}),
      extractResponseData: sinon.stub().returns({}),
      incrementBodyAnalysisCount: sinon.stub(),
      addDownstreamRequestMetric: sinon.stub(),
      handleResponseTracing: sinon.stub()
    }

    ssrf = proxyquire('../../../src/appsec/rasp/ssrf', {
      '../../../../datadog-core': { storage: () => legacyStorage },
      '../waf': waf,
      '../downstream_requests': downstream
    })

    const config = {
      appsec: {
        stackTrace: {
          enabled: true,
          maxStackTraces: 2,
          maxDepth: 42
        }
      }
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
        requestAddresses: { [addresses.HTTP_OUTGOING_METHOD]: 'GET' }
      })

      sinon.assert.calledOnceWithExactly(
        waf.run,
        {
          ephemeral: {
            [addresses.HTTP_OUTGOING_URL]: DEFAULT_URL,
            [addresses.HTTP_OUTGOING_METHOD]: 'GET'
          }
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

    it('captures response data when sampling enabled', () => {
      const ctx = makeCtx()
      const { req } = stubStore({}, {})

      const requestAddresses = { [addresses.HTTP_OUTGOING_METHOD]: 'POST' }
      const responseAddresses = {
        [addresses.HTTP_OUTGOING_RESPONSE_STATUS]: '200',
        [addresses.HTTP_OUTGOING_RESPONSE_BODY]: { ok: true }
      }

      downstream.extractResponseData.returns(responseAddresses)
      waf.run.onFirstCall().returns({ events: [] })
      waf.run.onSecondCall().returns({ events: [{ id: 'ssrf' }] })

      publishRequestStart({ ctx, includeBodies: true, requestAddresses })

      sinon.assert.calledOnceWithExactly(downstream.incrementBodyAnalysisCount, req)
      sinon.assert.calledWith(downstream.extractRequestData, ctx)
      sinon.assert.calledOnce(downstream.shouldSampleBody)

      const response = createResponse({ headers: { 'content-type': 'application/json' } })

      httpClientResponseData.publish({ ctx, res: response, chunk: Buffer.from('{"ok":true}') })
      httpClientResponseFinish.publish({ ctx, res: response })

      sinon.assert.calledWith(downstream.extractResponseData, response, true, sinon.match.instanceOf(Buffer))
      sinon.assert.calledOnceWithExactly(downstream.addDownstreamRequestMetric, req)
      sinon.assert.calledWith(downstream.handleResponseTracing, req, { type: 'ssrf', variant: 'response' })
    })

    it('does not collect body when sampling disabled', () => {
      const ctx = makeCtx()
      const { req } = stubStore({}, {})

      downstream.extractResponseData.returns({
        [addresses.HTTP_OUTGOING_RESPONSE_STATUS]: '200'
      })
      waf.run.returns({ events: [] })

      publishRequestStart({ ctx, includeBodies: false })

      const response = createResponse()
      httpClientResponseFinish.publish({ ctx, res: response })

      sinon.assert.calledWith(downstream.extractResponseData, response, false, null)
      sinon.assert.calledOnceWithExactly(downstream.addDownstreamRequestMetric, req)
    })

    it('concatenates string chunks', () => {
      const ctx = makeCtx()
      stubStore({}, {})

      downstream.extractResponseData.returns({
        [addresses.HTTP_OUTGOING_RESPONSE_STATUS]: '200'
      })
      waf.run.returns({ events: [] })

      publishRequestStart({ ctx, includeBodies: true })

      const response = createResponse({ headers: { 'content-type': 'text/plain' } })

      httpClientResponseData.publish({ ctx, res: response, chunk: 'hello ' })
      httpClientResponseData.publish({ ctx, res: response, chunk: 'world' })
      httpClientResponseFinish.publish({ ctx, res: response })

      sinon.assert.calledWith(downstream.extractResponseData, response, true, 'hello world')
    })

    it('concatenates buffer chunks', () => {
      const ctx = makeCtx()
      stubStore({}, {})

      downstream.extractResponseData.returns({
        [addresses.HTTP_OUTGOING_RESPONSE_STATUS]: '200'
      })
      waf.run.returns({ events: [] })

      publishRequestStart({ ctx, includeBodies: true })

      const response = createResponse()

      httpClientResponseData.publish({ ctx, res: response, chunk: Buffer.from('{"a":') })
      httpClientResponseData.publish({ ctx, res: response, chunk: Buffer.from('1}') })
      httpClientResponseFinish.publish({ ctx, res: response })

      const expectedBuffer = Buffer.from('{"a":1}')
      sinon.assert.calledWith(
        downstream.extractResponseData,
        response,
        true,
        sinon.match((arg) => Buffer.isBuffer(arg) && arg.equals(expectedBuffer))
      )
    })

    it('converts Uint8Array chunks to Buffer', () => {
      const ctx = makeCtx()
      stubStore({}, {})

      downstream.extractResponseData.returns({
        [addresses.HTTP_OUTGOING_RESPONSE_STATUS]: '200'
      })
      waf.run.returns({ events: [] })

      publishRequestStart({ ctx, includeBodies: true })

      const response = createResponse()

      httpClientResponseData.publish({ ctx, res: response, chunk: new Uint8Array([123, 125]) })
      httpClientResponseFinish.publish({ ctx, res: response })

      sinon.assert.calledWith(
        downstream.extractResponseData,
        response,
        true,
        sinon.match.instanceOf(Buffer)
      )
    })

    it('does not call response evaluation when no response addresses', () => {
      const ctx = makeCtx()
      stubStore({}, {})

      downstream.extractResponseData.returns({})
      waf.run.returns({ events: [] })

      publishRequestStart({ ctx, includeBodies: false })

      const response = createResponse()
      httpClientResponseFinish.publish({ ctx, res: response })

      sinon.assert.notCalled(downstream.addDownstreamRequestMetric)
      sinon.assert.calledOnce(waf.run)
    })
  })
})
