'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const { storage } = require('../../../datadog-core')
const addresses = require('../../src/appsec/addresses')
const { withRequest, getActiveRequest } = require('../../src/appsec/store')
const waf = require('../../src/appsec/waf')
const web = require('../../src/plugins/util/web')
const {
  startGraphqlResolver,
  graphqlMiddlewareChannel,
  apolloChannel,
  apolloServerCoreChannel,
  wafRunFinished,
} = require('../../src/appsec/channels')

/**
 * @param {unknown} resolverInfo
 * @param {object} [abortController]
 * @returns {{ abortController?: object, createResolverInfo: sinon.SinonStub }}
 */
function createResolverMessage (resolverInfo, abortController) {
  return {
    abortController,
    createResolverInfo: sinon.stub().returns(resolverInfo),
  }
}

describe('GraphQL', () => {
  let graphql, blocking, telemetry

  beforeEach(() => {
    const getBlockingData = sinon.stub()
    blocking = {
      getBlockingData,
      setTemplates: sinon.stub(),
      block: sinon.stub(),
    }

    getBlockingData.returns({
      headers: { 'Content-type': 'application/json' },
      body: '{ "message": "blocked" }',
      statusCode: 403,
    })

    telemetry = {
      updateBlockFailureMetric: sinon.stub(),
    }

    sinon.stub(waf, 'wafManager').value({
      getWAFContext: sinon.stub().returns({
        knownAddresses: new Set([addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]),
      }),
    })

    graphql = proxyquire('../../src/appsec/graphql', {
      './blocking': blocking,
      './telemetry': telemetry,
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('enable', () => {
    beforeEach(() => {
    })

    afterEach(() => {
      graphql.disable()
      sinon.restore()
    })

    it('Should subscribe to all channels', () => {
      assert.strictEqual(graphqlMiddlewareChannel.start.hasSubscribers, false)
      assert.strictEqual(apolloChannel.start.hasSubscribers, false)
      assert.strictEqual(apolloChannel.asyncEnd.hasSubscribers, false)
      assert.strictEqual(apolloServerCoreChannel.start.hasSubscribers, false)
      assert.strictEqual(apolloServerCoreChannel.asyncEnd.hasSubscribers, false)
      assert.strictEqual(startGraphqlResolver.hasSubscribers, false)
      assert.strictEqual(wafRunFinished.hasSubscribers, false)

      graphql.enable()

      assert.strictEqual(graphqlMiddlewareChannel.start.hasSubscribers, true)
      assert.strictEqual(apolloChannel.start.hasSubscribers, true)
      assert.strictEqual(apolloChannel.asyncEnd.hasSubscribers, true)
      assert.strictEqual(apolloServerCoreChannel.start.hasSubscribers, true)
      assert.strictEqual(apolloServerCoreChannel.asyncEnd.hasSubscribers, true)
      assert.strictEqual(startGraphqlResolver.hasSubscribers, true)
      assert.strictEqual(wafRunFinished.hasSubscribers, true)
    })
  })

  describe('disable', () => {
    it('Should unsubscribe from all channels', () => {
      graphql.enable()

      assert.strictEqual(graphqlMiddlewareChannel.start.hasSubscribers, true)
      assert.strictEqual(apolloChannel.start.hasSubscribers, true)
      assert.strictEqual(apolloChannel.asyncEnd.hasSubscribers, true)
      assert.strictEqual(apolloServerCoreChannel.start.hasSubscribers, true)
      assert.strictEqual(apolloServerCoreChannel.asyncEnd.hasSubscribers, true)
      assert.strictEqual(startGraphqlResolver.hasSubscribers, true)
      assert.strictEqual(wafRunFinished.hasSubscribers, true)

      graphql.disable()

      assert.strictEqual(graphqlMiddlewareChannel.start.hasSubscribers, false)
      assert.strictEqual(apolloChannel.start.hasSubscribers, false)
      assert.strictEqual(apolloChannel.asyncEnd.hasSubscribers, false)
      assert.strictEqual(apolloServerCoreChannel.start.hasSubscribers, false)
      assert.strictEqual(apolloServerCoreChannel.asyncEnd.hasSubscribers, false)
      assert.strictEqual(startGraphqlResolver.hasSubscribers, false)
      assert.strictEqual(wafRunFinished.hasSubscribers, false)
    })
  })

  describe('onGraphqlStartResolve', () => {
    beforeEach(() => {
      sinon.stub(waf, 'runSubContext').returns([''])
      sinon.stub(storage('legacy'), 'getStore').returns(withRequest(undefined, {}))
      sinon.stub(web, 'root').returns({})
      graphql.enable()
    })

    afterEach(() => {
      sinon.restore()
      graphql.disable()
    })

    it('Should not call waf if resolvers is undefined', () => {
      startGraphqlResolver.publish(createResolverMessage(undefined))

      sinon.assert.notCalled(waf.runSubContext)
    })

    it('Should not call waf if resolvers is not an object', () => {
      startGraphqlResolver.publish(createResolverMessage(''))

      sinon.assert.notCalled(waf.runSubContext)
    })

    it('Should not call waf if req is unavailable', () => {
      const resolverInfo = {
        user: [{ id: '1234' }],
      }

      storage('legacy').getStore.returns({})

      const message = createResolverMessage(resolverInfo)
      startGraphqlResolver.publish(message)

      sinon.assert.notCalled(waf.runSubContext)
      sinon.assert.notCalled(message.createResolverInfo)
    })

    it('Should skip resolver inputs when there is no active WAF context', () => {
      waf.wafManager.getWAFContext.returns(undefined)
      const message = createResolverMessage({ user: {} })
      startGraphqlResolver.publish(message)
      sinon.assert.notCalled(message.createResolverInfo)
      sinon.assert.notCalled(waf.runSubContext)
    })

    it('Should not materialize resolver inputs when the context does not use GraphQL data', () => {
      waf.wafManager.getWAFContext().knownAddresses.clear()
      const message = createResolverMessage({ user: {} })

      startGraphqlResolver.publish(message)

      sinon.assert.notCalled(message.createResolverInfo)
      sinon.assert.notCalled(waf.runSubContext)
    })

    it('Should call waf if resolvers is well formatted', () => {
      const resolverInfo = {
        user: [{ id: '1234' }],
      }

      const message = createResolverMessage(resolverInfo)
      startGraphqlResolver.publish(message)

      sinon.assert.calledOnceWithExactly(message.createResolverInfo, message)
      sinon.assert.calledOnceWithExactly(waf.runSubContext, {
        [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: resolverInfo,
      })
    })

    it('Should call waf once per request for repeated fields without arguments', () => {
      startGraphqlResolver.publish(createResolverMessage({ name: {} }))
      startGraphqlResolver.publish(createResolverMessage({ name: {} }))
      startGraphqlResolver.publish(createResolverMessage({ title: {} }))
      startGraphqlResolver.publish(createResolverMessage({ name: {} }))

      sinon.assert.calledTwice(waf.runSubContext)
      sinon.assert.calledWithExactly(
        waf.runSubContext.firstCall, { [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: { name: {} } }
      )
      sinon.assert.calledWithExactly(
        waf.runSubContext.secondCall, { [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: { title: {} } }
      )
    })

    it('Should call waf again for cached fields in a different request', () => {
      for (const input of [{}, { include: { if: undefined } }, { skip: { if: undefined } }]) {
        waf.runSubContext.resetHistory()
        startGraphqlResolver.publish(createResolverMessage({ name: input }))

        storage('legacy').getStore.returns(withRequest(undefined, {}))
        startGraphqlResolver.publish(createResolverMessage({ name: input }))
        sinon.assert.calledTwice(waf.runSubContext)
      }
    })

    it('Should call waf for every field with arguments or custom directives', () => {
      startGraphqlResolver.publish(createResolverMessage({ user: { id: '1234' } }))
      startGraphqlResolver.publish(createResolverMessage({ user: { id: '1234' } }))
      startGraphqlResolver.publish(createResolverMessage({ name: { case: { format: 'lower' } } }))
      startGraphqlResolver.publish(createResolverMessage({ name: { case: { format: 'lower' } } }))

      sinon.assert.callCount(waf.runSubContext, 4)
    })

    it('Should cache each distinct inclusion directive payload separately', () => {
      const inputs = [
        {},
        { include: { if: true } },
        { include: { if: false } },
        { skip: { if: true } },
        { skip: { if: false } },
        { include: { if: undefined } },
        { skip: { if: undefined } },
        { include: { if: true }, skip: { if: false } },
        { include: { if: undefined }, skip: { if: undefined } },
        { include: { if: true }, skip: { if: undefined } },
        { include: { if: undefined }, skip: { if: false } },
      ]
      for (const input of inputs) {
        startGraphqlResolver.publish(createResolverMessage({ name: input }))
        startGraphqlResolver.publish(createResolverMessage({ name: input }))
      }

      sinon.assert.callCount(waf.runSubContext, inputs.length)
      for (const [index, input] of inputs.entries()) {
        assert.deepStrictEqual(waf.runSubContext.getCall(index).args[0], {
          [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: { name: input },
        })
      }
    })

    for (const include of [null, true, { if: 'true' }, { if: null }, { if: true, extra: true }, { extra: true }]) {
      it(`Should not cache an unsupported directive shape ${JSON.stringify(include)}`, () => {
        startGraphqlResolver.publish(createResolverMessage({ name: { include } }))
        startGraphqlResolver.publish(createResolverMessage({ name: { include } }))

        sinon.assert.calledTwice(waf.runSubContext)
      })
    }

    it('Should not serve a field with arguments from the argument-less results', () => {
      // The same field name reaches both shapes when a query aliases it, e.g. `name, upper: name(upper: true)`.
      startGraphqlResolver.publish(createResolverMessage({ name: {} }))
      startGraphqlResolver.publish(createResolverMessage({ name: { upper: true } }))
      startGraphqlResolver.publish(createResolverMessage({ name: {} }))

      sinon.assert.calledTwice(waf.runSubContext)
      sinon.assert.calledWithExactly(
        waf.runSubContext.secondCall, { [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: { name: { upper: true } } }
      )
    })

    it('Should not keep the result of a timed out run', () => {
      waf.runSubContext.returns({ timeout: true })

      for (const input of [{}, { include: { if: true } }, { include: { if: undefined } },
        { skip: { if: undefined } }]) {
        waf.runSubContext.resetHistory()
        startGraphqlResolver.publish(createResolverMessage({ name: input }))
        startGraphqlResolver.publish(createResolverMessage({ name: input }))
        sinon.assert.calledTwice(waf.runSubContext)
      }
    })

    it('Should not keep the result of a run that returned nothing', () => {
      waf.runSubContext.returns(undefined)

      for (const input of [{}, { include: { if: true } }, { include: { if: undefined } },
        { skip: { if: undefined } }]) {
        waf.runSubContext.resetHistory()
        startGraphqlResolver.publish(createResolverMessage({ name: input }))
        startGraphqlResolver.publish(createResolverMessage({ name: input }))
        sinon.assert.calledTwice(waf.runSubContext)
      }
    })

    it('does not cache a failed evaluation that includes useful output', () => {
      waf.runSubContext.returns({ errorCode: -2, attributes: { diagnostic: 'value' } })
      startGraphqlResolver.publish(createResolverMessage({ name: {} }))
      startGraphqlResolver.publish(createResolverMessage({ name: {} }))

      sinon.assert.calledTwice(waf.runSubContext)
    })

    it('invalidates the originating request while another request is active', () => {
      const first = getActiveRequest()
      startGraphqlResolver.publish(createResolverMessage({ name: {} }))
      const second = {}
      storage('legacy').getStore.returns(withRequest(undefined, second))
      startGraphqlResolver.publish(createResolverMessage({ name: {} }))

      wafRunFinished.publish({ req: first, payload: { [addresses.USER_ID]: 'user' } })
      startGraphqlResolver.publish(createResolverMessage({ name: {} }))
      sinon.assert.calledTwice(waf.runSubContext)

      storage('legacy').getStore.returns(withRequest(undefined, first))
      startGraphqlResolver.publish(createResolverMessage({ name: {} }))
      sinon.assert.calledThrice(waf.runSubContext)
    })

    it('Should forget fields without arguments when a run carries request context inputs', () => {
      // setUser can add `usr.id` mid-request, and a rule can require both that and the resolver field.
      startGraphqlResolver.publish(createResolverMessage({ name: {} }))
      sinon.assert.calledOnce(waf.runSubContext)

      wafRunFinished.publish({ req: getActiveRequest(), payload: { [addresses.USER_ID]: 'user' } })

      startGraphqlResolver.publish(createResolverMessage({ name: {} }))

      sinon.assert.calledTwice(waf.runSubContext)
    })

    it('Should keep fields without arguments when a subcontext is evaluated', () => {
      startGraphqlResolver.publish(createResolverMessage({ name: {} }))

      wafRunFinished.publish({
        req: getActiveRequest(),
        payload: { [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: { name: {} } },
        isSubcontext: true,
      })

      startGraphqlResolver.publish(createResolverMessage({ name: {} }))

      sinon.assert.calledOnce(waf.runSubContext)
    })
  })

  describe('block response', () => {
    const req = {}
    const res = {}
    const resolverInfo = {
      user: [{ id: '1234' }],
    }
    const blockParameters = {
      status_code: 401,
      type: 'auto',
      grpc_status_code: 10,
    }

    let context, rootSpan

    beforeEach(() => {
      sinon.stub(storage('legacy'), 'getStore').returns(withRequest(undefined, req))

      graphql.enable()
      graphqlMiddlewareChannel.start.publish({ req, res })
      apolloChannel.start.publish()
      context = {
        abortController: {
          abort: sinon.stub(),
        },
      }
      rootSpan = { setTag: sinon.stub() }
    })

    afterEach(() => {
      graphql.disable()
      sinon.restore()
    })

    it('Should not call abort', () => {
      const abortController = {}

      sinon.stub(waf, 'runSubContext').returns([''])

      startGraphqlResolver.publish(createResolverMessage(resolverInfo, abortController))

      sinon.assert.calledOnceWithExactly(waf.runSubContext, {
        [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: resolverInfo,
      })

      sinon.assert.notCalled(context.abortController.abort)

      apolloChannel.asyncEnd.publish({ abortController })

      sinon.assert.notCalled(blocking.getBlockingData)
    })

    it('Should call abort', () => {
      const abortController = context.abortController

      sinon.stub(waf, 'runSubContext').returns({
        actions: {
          block_request: blockParameters,
        },
      })

      sinon.stub(web, 'root').returns(rootSpan)

      startGraphqlResolver.publish(createResolverMessage(resolverInfo, abortController))

      sinon.assert.calledOnceWithExactly(waf.runSubContext, {
        [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: resolverInfo,
      })

      sinon.assert.called(context.abortController.abort)

      const abortData = {}
      apolloChannel.asyncEnd.publish({ abortController, abortData })

      sinon.assert.calledOnceWithExactly(blocking.getBlockingData, req, 'graphqlJson', blockParameters)

      sinon.assert.calledOnceWithExactly(rootSpan.setTag, 'appsec.blocked', 'true')
      sinon.assert.notCalled(telemetry.updateBlockFailureMetric)
    })

    it('Should abort every occurrence of a blocked cached field', () => {
      const firstAbortController = { abort: sinon.stub() }
      const secondAbortController = { abort: sinon.stub() }

      sinon.stub(waf, 'runSubContext').returns({
        actions: {
          block_request: blockParameters,
        },
      })

      sinon.stub(web, 'root').returns(rootSpan)

      for (const input of [{}, { include: { if: true } }, { include: { if: undefined } },
        { skip: { if: undefined } }]) {
        waf.runSubContext.resetHistory()
        firstAbortController.abort.resetHistory()
        secondAbortController.abort.resetHistory()
        const resolverInfo = { __schema: input }
        startGraphqlResolver.publish(createResolverMessage(resolverInfo, firstAbortController))
        startGraphqlResolver.publish(createResolverMessage(resolverInfo, secondAbortController))

        sinon.assert.calledOnce(waf.runSubContext)
        sinon.assert.calledOnce(firstAbortController.abort)
        sinon.assert.calledOnce(secondAbortController.abort)
      }

      const abortData = {}
      apolloChannel.asyncEnd.publish({ abortController: firstAbortController, abortData })

      sinon.assert.calledOnceWithExactly(blocking.getBlockingData, req, 'graphqlJson', blockParameters)
      sinon.assert.calledOnceWithExactly(rootSpan.setTag, 'appsec.blocked', 'true')
    })

    it('Should catch error when block fails', () => {
      blocking.getBlockingData.returns(undefined)

      const abortController = context.abortController

      sinon.stub(waf, 'runSubContext').returns({
        actions: {
          block_request: blockParameters,
        },
      })

      sinon.stub(web, 'root').returns(rootSpan)

      startGraphqlResolver.publish(createResolverMessage(resolverInfo, abortController))

      sinon.assert.calledOnceWithExactly(waf.runSubContext, {
        [addresses.HTTP_INCOMING_GRAPHQL_RESOLVER]: resolverInfo,
      })

      sinon.assert.calledOnce(abortController.abort)

      const abortData = {}
      apolloChannel.asyncEnd.publish({ abortController, abortData })

      sinon.assert.calledOnceWithExactly(blocking.getBlockingData, req, 'graphqlJson', blockParameters)

      sinon.assert.calledOnceWithExactly(rootSpan.setTag, '_dd.appsec.block.failed', 1)
      sinon.assert.calledOnceWithExactly(telemetry.updateBlockFailureMetric, req)
    })

    it('Should call abort when apolloChannel is the only seeder (Apollo v5 external Express integration)', () => {
      // Reproduces Apollo v5 + @as-integrations/express{4,5} without drainHttpServer:
      // neither graphqlMiddlewareChannel nor apolloHttpServerChannel seeds graphqlRequestData,
      // so enterInApolloRequest must seed it itself.
      graphql.disable()
      graphql.enable()
      apolloChannel.start.publish()

      const abortController = context.abortController

      sinon.stub(waf, 'runSubContext').returns({
        actions: {
          block_request: blockParameters,
        },
      })

      sinon.stub(web, 'root').returns(rootSpan)

      startGraphqlResolver.publish(createResolverMessage(resolverInfo, abortController))

      sinon.assert.called(context.abortController.abort)

      const abortData = {}
      apolloChannel.asyncEnd.publish({ abortController, abortData })

      sinon.assert.calledWithExactly(blocking.getBlockingData, req, 'graphqlJson', blockParameters)
      sinon.assert.calledWithExactly(rootSpan.setTag, 'appsec.blocked', 'true')
    })
  })
})
