'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('events')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const dc = require('dc-polyfill')

const { storage } = require('../../../../datadog-core')
const {
  httpClientRequestStart,
  httpClientResponseStart,
  httpClientResponseFinish,
} = require('../../../src/appsec/channels')
const addresses = require('../../../src/appsec/addresses')
const { getActiveRequest, withRequest } = require('../../../src/appsec/store')

const DEFAULT_URL = 'http://example.com'

describe('RASP - ssrf.js', () => {
  let waf, run, contexts
  let downstream
  let ssrf
  let telemetry

  let nextIncludeBodies

  const makeCtx = (overrides = {}) => ({
    args: {
      uri: DEFAULT_URL,
      options: {},
    },
    abortController: {},
    ...overrides,
  })

  const stubStore = (req = {}, res = {}) => {
    storage('legacy').enterWith(req ? withRequest(undefined, req) : {})
    return { req, res }
  }

  const clearStore = () => {
    storage('legacy').enterWith({})
  }

  const publishRequestStart = ({ ctx, includeBodies = false, requestAddresses = {} }) => {
    nextIncludeBodies = includeBodies
    downstream.extractRequestData.returns(requestAddresses)
    httpClientRequestStart.publish(ctx)
  }

  const publishResponseStart = (ctx, res) => {
    httpClientResponseStart.publish({ ctx, res })
  }

  const createResponse = ({ statusCode = 200, headers = {} } = {}) => {
    const response = new EventEmitter()
    response.statusCode = statusCode
    response.headers = headers
    return response
  }

  beforeEach(() => {
    nextIncludeBodies = false

    run = sinon.stub()
    contexts = new WeakMap()
    waf = {
      runSubContext: sinon.stub().callsFake((data, rule, ctx) => {
        let context = ctx.wafSubcontext
        if (!context) {
          context = {
            parent: { req: getActiveRequest() },
            run: sinon.spy((...args) => run(...args)),
            dispose: sinon.spy(),
          }
          ctx.wafSubcontext = context
        }
        contexts.set(ctx, context)
        return context.run(data, rule)
      }),
      getRequest: sinon.spy(ctx => ctx.wafSubcontext?.parent.req),
      disposeSubContext: sinon.spy(ctx => {
        ctx.wafSubcontext?.dispose()
        ctx.wafSubcontext = undefined
        contexts.delete(ctx)
      }),
    }

    downstream = {
      enable: sinon.stub(),
      disable: sinon.stub(),
      extractRequestData: sinon.stub().returns({}),
      extractResponseData: sinon.stub().returns({}),
      incrementDownstreamAnalysisCount: sinon.stub(),
      planResponseBodyCollection: sinon.stub().callsFake((originatingReq, res, ctx) => {
        delete ctx.shouldCollectBody

        const location = res.headers?.location
        const isRedirect = res.statusCode >= 300 && res.statusCode < 400 && location
        if (isRedirect) {
          return
        }

        if (nextIncludeBodies) {
          ctx.shouldCollectBody = true
        }
      }),
    }

    telemetry = {
      updateRaspRuleMatchMetricTags: sinon.stub(),
    }

    ssrf = proxyquire('../../../src/appsec/rasp/ssrf', {
      '../waf': waf,
      '../downstream_requests': downstream,
      '../telemetry': telemetry,
    })

    const config = {
      appsec: {
        DD_APPSEC_STACK_TRACE_ENABLED: true,
        DD_APPSEC_MAX_STACK_TRACES: 2,
        DD_APPSEC_MAX_STACK_TRACE_DEPTH: 42,
      },
    }

    ssrf.enable(config)
  })

  afterEach(() => {
    sinon.restore()
    ssrf.disable()
    clearStore()
  })

  it('unsubscribes from requests when disabled', () => {
    assert.strictEqual(httpClientRequestStart.hasSubscribers, true)
    ssrf.disable()
    assert.strictEqual(httpClientRequestStart.hasSubscribers, false)
  })

  it('evaluates redirect headers immediately and disposes each hop independently', () => {
    stubStore()
    const first = makeCtx()
    const second = makeCtx({ args: { uri: 'http://example.com/next', options: {} } })
    publishRequestStart({ ctx: first })
    const firstScope = contexts.get(first)
    downstream.extractResponseData.returns({ [addresses.HTTP_OUTGOING_RESPONSE_STATUS]: '302' })
    const redirect = createResponse({ statusCode: 302, headers: { location: '/next' } })
    publishResponseStart(first, redirect)
    sinon.assert.calledTwice(firstScope.run)
    sinon.assert.notCalled(downstream.planResponseBodyCollection)
    publishRequestStart({ ctx: second })
    const secondScope = contexts.get(second)
    assert.notStrictEqual(firstScope, secondScope)

    httpClientResponseFinish.publish({ ctx: first, res: redirect, body: null })
    sinon.assert.calledTwice(firstScope.run)
    sinon.assert.calledOnce(firstScope.dispose)
    sinon.assert.notCalled(secondScope.dispose)

    httpClientResponseFinish.publish({ ctx: second, res: createResponse(), body: null })
    sinon.assert.calledTwice(secondScope.run)
    sinon.assert.calledOnce(secondScope.dispose)
  })

  it('prefers the outgoing URL from request options', () => {
    stubStore()
    const ctx = makeCtx({
      args: {
        uri: 'http://fallback.example/wrong/start',
        options: { uri: { protocol: 'http:', host: 'example.com', pathname: '/right/start' } },
      },
    })
    publishRequestStart({ ctx })
    assert.strictEqual(run.firstCall.args[0][addresses.HTTP_OUTGOING_URL], 'http://example.com/right/start')
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
        waf.runSubContext,
        {
          [addresses.HTTP_OUTGOING_URL]: DEFAULT_URL,
          [addresses.HTTP_OUTGOING_METHOD]: 'GET',
        },
        { type: 'ssrf', variant: 'request' },
        ctx
      )
      sinon.assert.calledOnceWithExactly(downstream.incrementDownstreamAnalysisCount, req)
      assert.strictEqual(Object.hasOwn(ctx, 'appsecRequest'), false)
    })

    it('uses the same scope and originating request for response evaluation', () => {
      const ctx = makeCtx()
      const { req } = stubStore()
      downstream.extractResponseData.returns({ [addresses.HTTP_OUTGOING_RESPONSE_STATUS]: '200' })
      publishRequestStart({ ctx })
      const scope = contexts.get(ctx)
      run.onSecondCall().returns({ events: [{}] })
      const res = createResponse()
      stubStore() // Response callbacks can run under a different active request.
      publishResponseStart(ctx, res)
      sinon.assert.calledWith(downstream.planResponseBodyCollection, req, res, ctx)
      httpClientResponseFinish.publish({ ctx, res, body: null })
      sinon.assert.calledWithExactly(
        scope.run,
        { [addresses.HTTP_OUTGOING_RESPONSE_STATUS]: '200' },
        { type: 'ssrf', variant: 'response' }
      )
      sinon.assert.calledOnce(scope.dispose)
      sinon.assert.calledOnceWithExactly(telemetry.updateRaspRuleMatchMetricTags,
        req, { type: 'ssrf', variant: 'response' }, false, false)
      httpClientResponseFinish.publish({ ctx, res, body: null })
      sinon.assert.calledTwice(run)
    })

    it('isolates concurrent outgoing requests and redirect hops', () => {
      stubStore()
      const first = makeCtx({ req: new EventEmitter() })
      const second = makeCtx({ req: new EventEmitter() })
      publishRequestStart({ ctx: first })
      publishRequestStart({ ctx: second })
      const firstScope = contexts.get(first)
      const secondScope = contexts.get(second)
      assert.notStrictEqual(firstScope, secondScope)
      httpClientResponseFinish.publish({ ctx: first, res: createResponse({ statusCode: 302 }), body: null })
      sinon.assert.calledOnce(firstScope.dispose)
      sinon.assert.notCalled(secondScope.dispose)
      assert.strictEqual(contexts.get(second), secondScope)
      httpClientResponseFinish.publish({ ctx: second, res: createResponse(), body: null })
      sinon.assert.calledOnce(secondScope.dispose)
    })

    it('retains the subcontext when a timeout is followed by a response', () => {
      stubStore()
      const ctx = makeCtx({ req: new EventEmitter() })
      downstream.extractResponseData.returns({ [addresses.HTTP_OUTGOING_RESPONSE_STATUS]: '200' })
      publishRequestStart({ ctx })
      const scope = contexts.get(ctx)

      ctx.req.emit('timeout')
      // The HTTP instrumentation publishes request finish on timeout, before a possible response.
      dc.channel('apm:http:client:request:finish').publish(ctx)
      sinon.assert.notCalled(scope.dispose)
      httpClientResponseFinish.publish({ ctx, res: createResponse(), body: null })

      sinon.assert.calledTwice(scope.run)
      sinon.assert.calledWithExactly(scope.run.secondCall,
        { [addresses.HTTP_OUTGOING_RESPONSE_STATUS]: '200' }, { type: 'ssrf', variant: 'response' })
      sinon.assert.calledOnce(scope.dispose)
    })

    it('releases the scope on response completion even without response data', () => {
      stubStore()
      const ctx = makeCtx({ req: new EventEmitter() })
      publishRequestStart({ ctx })
      const scope = contexts.get(ctx)
      httpClientResponseFinish.publish({ ctx, res: createResponse(), body: null })
      sinon.assert.calledOnce(scope.dispose)
    })

    it('does not create a response context under another request after initial creation failed', () => {
      stubStore()
      waf.runSubContext.resetBehavior()
      const ctx = makeCtx()
      publishRequestStart({ ctx })
      stubStore() // The response runs under an unrelated incoming request.
      downstream.extractResponseData.returns({ [addresses.HTTP_OUTGOING_RESPONSE_STATUS]: '200' })
      const res = createResponse()
      publishResponseStart(ctx, res)
      httpClientResponseFinish.publish({ ctx, res, body: null })

      sinon.assert.calledOnce(waf.runSubContext)
      sinon.assert.notCalled(downstream.planResponseBodyCollection)
      sinon.assert.notCalled(downstream.extractResponseData)
      sinon.assert.notCalled(run)
      assert.strictEqual(contexts.has(ctx), false)
    })

    it('should not analyze ssrf if rasp is disabled', () => {
      ssrf.disable()

      const ctx = makeCtx()
      stubStore({}, {})

      httpClientRequestStart.publish(ctx)

      sinon.assert.notCalled(run)
    })

    it('should not analyze ssrf if no store', () => {
      const ctx = makeCtx()
      clearStore()

      httpClientRequestStart.publish(ctx)

      sinon.assert.notCalled(run)
    })

    it('should not analyze ssrf if no req', () => {
      const ctx = makeCtx()
      stubStore(null, {})

      httpClientRequestStart.publish(ctx)

      sinon.assert.notCalled(run)
    })

    it('should not analyze ssrf if no url', () => {
      const ctx = makeCtx({ args: { uri: null, options: {} } })
      stubStore({}, {})

      httpClientRequestStart.publish(ctx)

      sinon.assert.notCalled(run)
    })

    it('does not set shouldCollectBody until response headers when sampling disabled', () => {
      const ctx = makeCtx()
      stubStore({}, {})

      publishRequestStart({ ctx, includeBodies: false })
      sinon.assert.match(ctx.shouldCollectBody, sinon.match.undefined)

      publishResponseStart(ctx, createResponse())
      assert.strictEqual(ctx.shouldCollectBody, undefined)
    })

    it('sets shouldCollectBody when body sampling is enabled at response', () => {
      const ctx = makeCtx()
      stubStore({}, {})

      publishRequestStart({ ctx, includeBodies: true })
      publishResponseStart(ctx, createResponse())

      sinon.assert.calledOnce(downstream.planResponseBodyCollection)
      sinon.assert.match(ctx.shouldCollectBody, true)
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
      run.onFirstCall().returns({ events: [] })
      run.onSecondCall().returns({ events: [{ id: 'ssrf' }] })

      publishRequestStart({ ctx, includeBodies: true, requestAddresses })
      const response = createResponse({ headers: { 'content-type': 'application/json' } })
      publishResponseStart(ctx, response)
      const body = Buffer.from('{"ok":true}')

      httpClientResponseFinish.publish({ ctx, res: response, body })

      sinon.assert.calledWith(downstream.extractResponseData, response, body)
      sinon.assert.calledOnceWithExactly(downstream.incrementDownstreamAnalysisCount, req)
      sinon.assert.calledWith(
        telemetry.updateRaspRuleMatchMetricTags, req, { type: 'ssrf', variant: 'response' }, false, false)
      sinon.assert.calledTwice(run)
    })

    it('evaluates response without body when body is null', () => {
      const ctx = makeCtx()
      const { req } = stubStore({}, {})

      downstream.extractResponseData.returns({
        [addresses.HTTP_OUTGOING_RESPONSE_STATUS]: '200',
      })
      run.returns({ events: [] })

      publishRequestStart({ ctx, includeBodies: false })
      publishResponseStart(ctx, createResponse())

      const response = createResponse()
      httpClientResponseFinish.publish({ ctx, res: response, body: null })

      sinon.assert.calledWith(downstream.extractResponseData, response, null)
      sinon.assert.calledOnceWithExactly(downstream.incrementDownstreamAnalysisCount, req)
      sinon.assert.calledTwice(run)
    })

    it('does not call response evaluation when no response addresses', () => {
      const ctx = makeCtx()
      const { req } = stubStore({}, {})

      downstream.extractResponseData.returns({})
      run.returns({ events: [] })

      publishRequestStart({ ctx, includeBodies: false })
      publishResponseStart(ctx, createResponse())

      const response = createResponse()
      httpClientResponseFinish.publish({ ctx, res: response, body: null })

      sinon.assert.calledOnceWithExactly(downstream.incrementDownstreamAnalysisCount, req)
      sinon.assert.calledOnce(run) // only for request
    })

    it('handles redirect responses and skips body analysis', () => {
      const ctx = makeCtx()
      stubStore({}, {})

      downstream.extractResponseData.returns({
        [addresses.HTTP_OUTGOING_RESPONSE_STATUS]: '302',
        [addresses.HTTP_OUTGOING_RESPONSE_HEADERS]: { location: 'http://example.com/redirect' },
      })
      run.returns({ events: [] })

      publishRequestStart({ ctx, includeBodies: true })

      const response = createResponse({ statusCode: 302, headers: { location: 'http://example.com/redirect' } })
      publishResponseStart(ctx, response)

      assert.strictEqual(ctx.shouldCollectBody, undefined)

      const body = Buffer.from('redirect body')
      httpClientResponseFinish.publish({ ctx, res: response, body })

      sinon.assert.calledWith(downstream.extractResponseData, response, null)

      sinon.assert.calledTwice(run)
    })

    it('passes body for non-redirect responses', () => {
      const ctx = makeCtx()
      stubStore({}, {})

      downstream.extractResponseData.returns({
        [addresses.HTTP_OUTGOING_RESPONSE_STATUS]: '200',
        [addresses.HTTP_OUTGOING_RESPONSE_BODY]: { ok: true },
      })
      run.returns({ events: [] })

      publishRequestStart({ ctx, includeBodies: true })

      const response = createResponse({ statusCode: 200 })
      publishResponseStart(ctx, response)
      const body = Buffer.from('{"ok":true}')
      httpClientResponseFinish.publish({ ctx, res: response, body })

      sinon.assert.calledWith(downstream.extractResponseData, response, body)
    })

    it('redirect response does not enable body collection when sampling is disabled', () => {
      const ctx = makeCtx()
      stubStore({}, {})

      publishRequestStart({ ctx, includeBodies: false })

      const response = createResponse({ statusCode: 302, headers: { location: 'http://example.com/redirect' } })
      publishResponseStart(ctx, response)

      assert.strictEqual(ctx.shouldCollectBody, undefined)
    })

    it('passes null body when shouldCollectBody is false even for non-redirect', () => {
      const ctx = makeCtx()
      stubStore({}, {})

      downstream.extractResponseData.returns({
        [addresses.HTTP_OUTGOING_RESPONSE_STATUS]: '200',
      })
      run.returns({ events: [] })

      publishRequestStart({ ctx, includeBodies: false })
      publishResponseStart(ctx, createResponse({ statusCode: 200 }))

      const response = createResponse({ statusCode: 200 })
      const body = Buffer.from('{"data":"test"}')
      httpClientResponseFinish.publish({ ctx, res: response, body })

      sinon.assert.calledWith(downstream.extractResponseData, response, null)
    })

    it('skips body analysis for redirect response at finish', () => {
      const ctx = makeCtx()
      stubStore({}, {})

      downstream.extractResponseData.returns({
        [addresses.HTTP_OUTGOING_RESPONSE_STATUS]: '302',
      })
      run.returns({ events: [] })

      publishRequestStart({ ctx, includeBodies: true })

      const response = createResponse({ statusCode: 302, headers: { location: 'http://example.com/redirect' } })
      publishResponseStart(ctx, response)
      httpClientResponseFinish.publish({
        ctx,
        res: response,
        body: null,
      })

      sinon.assert.calledWith(downstream.extractResponseData, response, null)
    })

    it('skips WAF body when shouldCollectBody is false even if finish payload includes body', () => {
      const ctx = makeCtx()
      stubStore({}, {})

      downstream.extractResponseData.returns({
        [addresses.HTTP_OUTGOING_RESPONSE_STATUS]: '200',
      })
      run.returns({ events: [] })

      publishRequestStart({ ctx, includeBodies: false })
      publishResponseStart(ctx, createResponse({ statusCode: 200 }))

      const response = createResponse()
      const body = Buffer.from('{"ok":true}')

      httpClientResponseFinish.publish({
        ctx,
        res: response,
        body,
      })

      sinon.assert.calledWith(downstream.extractResponseData, response, null)
    })
  })
})
